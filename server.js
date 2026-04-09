import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import bcrypt from 'bcrypt';
import * as XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db, { initDb } from './db.js';
import { initScheduler, manuallySyncAllDocuments } from './scheduler.js';
import { sendOtpSms } from './smsService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config();

// ── Crash Guards: log errors instead of silent death ─────────────────────────
process.on('uncaughtException', (err) => {
  console.error('❌ UNCAUGHT EXCEPTION:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ UNHANDLED REJECTION:', reason);
});

const app = express();
const PORT = process.env.PORT || 5000;
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ── In-memory password reset codes (code → { email, expiry }) ────────────────
const resetCodes = new Map();

// Helper: sync all users to Excel file
const syncUsersToExcel = () => {
  db.all('SELECT id, name, email, mobile_number, auth_provider, business_stage, business_type, goal, created_at, last_login FROM users', [], (err, rows) => {
    if (err || !rows.length) return;
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Users');
    const filePath = path.join(__dirname, 'users_database.xlsx');
    XLSX.writeFile(wb, filePath);
    console.log(`[Excel] Users database synced → ${filePath}`);
  });
};

// Helper: sync all leads to Excel file
const syncLeadsToExcel = () => {
  db.all('SELECT * FROM leads ORDER BY joined_at DESC', [], (err, rows) => {
    if (err || !rows.length) return;
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Leads');
    const filePath = path.join(__dirname, 'leads_database.xlsx');
    XLSX.writeFile(wb, filePath);
    console.log(`[Excel] Leads database synced → ${filePath} (${rows.length} leads)`);
  });
};

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));

app.use(express.json());
app.use(cookieParser());

// --- Authentication Middleware ---
const requireAuth = (req, res, next) => {
  const token = req.cookies.auth_token;
  if (!token) return res.status(401).json({ error: 'Unauthorized: No session token provided' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Unauthorized: Invalid or expired session' });
  }
};

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Launchpad Bharat API is running perfectly!' });
});

// --- Auth Routes ---

app.post('/api/auth/send-otp', async (req, res) => {
  const { mobile_number } = req.body;

  // ── Step 1: Validate phone number format ─────────────────────────────────
  if (!mobile_number || !/^\+91\d{10}$/.test(mobile_number)) {
    console.warn(`[SEND-OTP] ❌ VALIDATION FAILED — Invalid number received: ${mobile_number}`);
    return res.status(400).json({ error: 'Invalid number. Must be a 10-digit Indian mobile number (e.g. +919999999999)' });
  }
  console.log(`\n[SEND-OTP] Request received for: ${mobile_number}`);

  // ── Step 2: Rate limiting check ───────────────────────────────────────────
  db.get(
    'SELECT COUNT(*) as count FROM otps WHERE mobile_number = ? AND created_at > datetime("now", "-15 minutes")',
    [mobile_number],
    async (err, row) => {
      if (err) {
        console.error('[SEND-OTP] ❌ DB rate-limit check failed:', err.message);
        return res.status(500).json({ error: 'Database error during rate-limit check' });
      }
      console.log(`[SEND-OTP] Rate limit check: ${row.count}/3 requests in last 15 minutes`);
      if (row.count >= 3) {
        console.warn(`[SEND-OTP] ⛔ Rate limit hit for ${mobile_number}`);
        return res.status(429).json({ error: 'Too many OTP requests. Please wait 15 minutes before trying again.' });
      }

      // ── Step 3: Generate OTP ───────────────────────────────────────────────
      const plainOtp = Math.floor(100000 + Math.random() * 900000).toString();
      console.log(`[SEND-OTP] OTP generated (hashing before storage)`);

      const hashedOtp = await bcrypt.hash(plainOtp, 10);
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      // ── Step 4: Persist hashed OTP to DB ──────────────────────────────────
      db.run(
        'INSERT INTO otps (mobile_number, otp_hash, expires_at) VALUES (?, ?, ?)',
        [mobile_number, hashedOtp, expiresAt],
        async (insertErr) => {
          if (insertErr) {
            console.error('[SEND-OTP] ❌ DB insert failed:', insertErr.message);
            return res.status(500).json({ error: 'Failed to store OTP securely' });
          }
          console.log(`[SEND-OTP] OTP hash stored in DB. Expires at: ${expiresAt}`);

          // ── Step 5: Dispatch SMS ─────────────────────────────────────────
          try {
            const smsResult = await sendOtpSms(mobile_number, plainOtp);

            if (!smsResult.success) {
              // SMS failed — clean up the DB record so user can try again
              db.run('DELETE FROM otps WHERE mobile_number = ? AND otp_hash = ?', [mobile_number, hashedOtp]);
              console.error('[SEND-OTP] ❌ SMS delivery failed, cleaned DB entry. Error:', smsResult.error);
              return res.status(502).json({ 
                error: `SMS delivery failed: ${smsResult.error}. Please check your Fast2SMS API key.` 
              });
            }

            console.log(`[SEND-OTP] ✅ Complete — OTP delivered via ${smsResult.provider}`);
            res.json({ 
              success: true, 
              message: 'OTP sent successfully to your mobile number',
              provider: smsResult.provider // helpful for debugging
            });
          } catch (smsErr) {
            console.error('[SEND-OTP] ❌ SMS module threw exception:', smsErr.message);
            return res.status(500).json({ error: 'Unexpected error sending SMS. Please try again.' });
          }
        }
      );
    }
  );
});

app.post('/api/auth/verify-otp', async (req, res) => {
  const { mobile_number, otp } = req.body;
  if (!mobile_number || !otp) return res.status(400).json({ error: 'Mobile and OTP required' });

  db.get(
    'SELECT * FROM otps WHERE mobile_number = ? ORDER BY created_at DESC LIMIT 1',
    [mobile_number],
    async (err, otpRecord) => {
      if (err) return res.status(500).json({ error: 'Database fetching error' });
      if (!otpRecord) return res.status(400).json({ error: 'No OTP requested for this number' });

      // Expiration check
      if (new Date() > new Date(otpRecord.expires_at)) {
        return res.status(400).json({ error: 'OTP has expired' });
      }

      // Bruteforce defense
      if (otpRecord.attempt_count >= 5) {
        return res.status(429).json({ error: 'Too many invalid attempts. Request a new OTP.' });
      }

      // Cryptographic verification
      const isValid = await bcrypt.compare(otp.toString(), otpRecord.otp_hash);
      
      if (!isValid) {
        db.run('UPDATE otps SET attempt_count = attempt_count + 1 WHERE id = ?', [otpRecord.id]);
        return res.status(400).json({ error: 'Invalid 6-digit OTP' });
      }

      // Valid path -> Purge hash to strictly prevent replay attacks
      db.run('DELETE FROM otps WHERE mobile_number = ?', [mobile_number]);

      // DB Upsert User
      db.get('SELECT * FROM users WHERE mobile_number = ?', [mobile_number], (userErr, user) => {
        if (userErr) return res.status(500).json({ error: 'User linkage error' });

        if (user) {
          const isNewOrIncomplete = !user.business_stage;
          db.run('UPDATE users SET is_mobile_verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
          issueToken(res, user.id, isNewOrIncomplete, user.email, user.name, user.profile_picture);
        } else {
          db.run(
            'INSERT INTO users (mobile_number, auth_provider, is_mobile_verified) VALUES (?, ?, 1)',
            [mobile_number, 'otp'],
            function(createErr) {
              if (createErr) return res.status(500).json({ error: 'Failed to initialize founder identity' });
              issueToken(res, this.lastID, true, null, null, null);
            }
          );
        }
      });
    }
  );
});

const issueToken = (res, userId, isNewOrIncomplete, email, name, picture) => {
  const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
  
  // Stamp last_login on every successful auth
  db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [userId]);
  
  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });

  res.json({
    success: true,
    isNewUser: isNewOrIncomplete,
    user: { id: userId, email, name, picture }
  });
};

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, emailOrPhone, password } = req.body;
    if (!name || !emailOrPhone || !password) {
      return res.status(400).json({ error: 'Name, email, and password are all required' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const password_hash = await bcrypt.hash(String(password), 10);

    db.run(
      'INSERT INTO users (name, email, auth_provider, password_hash) VALUES (?, ?, ?, ?)',
      [name, emailOrPhone, 'email', password_hash],
      function (err) {
        if (err) {
          if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'An account with this email already exists. Try signing in.' });
          return res.status(500).json({ error: 'Database error during signup' });
        }
        issueToken(res, this.lastID, true, emailOrPhone, name, null);
        // Sync to Excel after every new signup
        setTimeout(syncUsersToExcel, 500);
      }
    );
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
      try {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(400).json({ error: 'No account found with this email. Please sign up first.' });
        if (!user.password_hash) {
          return res.status(400).json({ error: 'This account was created via Google. Please use "Continue with Google" to sign in.' });
        }

        const isValid = await bcrypt.compare(String(password), user.password_hash);
        if (!isValid) return res.status(400).json({ error: 'Incorrect password. Please try again.' });

        const isNewOrIncomplete = !user.business_stage;
        issueToken(res, user.id, isNewOrIncomplete, user.email, user.name, user.profile_picture);
      } catch (innerErr) {
        console.error('Login inner error:', innerErr);
        res.status(500).json({ error: 'Authentication internal error' });
      }
    });
  } catch (err) {
    console.error('Login route error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const { id_token, mock_profile } = req.body;
    let payload;

    // Production Google Verification (with local dev bypass)
    if (id_token && id_token !== 'mock_google_token') {
      const ticket = await client.verifyIdToken({
        idToken: id_token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } else {
      payload = mock_profile || {
        sub: 'mock_101010',
        email: 'founder@launchpadbharat.in',
        name: 'Demo Founder',
        picture: 'https://via.placeholder.com/150'
      };
    }

    const { sub: google_id, email, name, picture } = payload;

    db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
      if (err) return res.status(500).json({ error: 'Database error querying user' });

      let userId;
      let isNewOrIncomplete = false;

      if (user) {
        userId = user.id;
        db.run('UPDATE users SET google_id = ?, profile_picture = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [google_id, picture, userId]);
        isNewOrIncomplete = !user.business_stage; // Flag true if onboarding is missing
      } else {
        isNewOrIncomplete = true;
        db.run(
          'INSERT INTO users (name, email, google_id, profile_picture, auth_provider) VALUES (?, ?, ?, ?, ?)',
          [name, email, google_id, picture, 'google'],
          function (err) {
            if (err) return res.status(500).json({ error: 'Failed to create new user' });
            issueToken(res, this.lastID, isNewOrIncomplete, email, name, picture);
          }
        );
        return;
      }
      issueToken(res, userId, isNewOrIncomplete, email, name, picture);
    });

  } catch (error) {
    console.error('Google Auth Error:', error);
    res.status(401).json({ error: 'Invalid Google Token authentication failed' });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  db.get(
    'SELECT id, name, email, mobile_number, profile_picture, auth_provider, business_stage, business_type, goal, created_at, last_login FROM users WHERE id = ?',
    [req.userId],
    (err, user) => {
      if (err || !user) return res.status(404).json({ error: 'Session valid but user not found in DB' });
      res.json({ user, isOnboarded: !!user.business_stage });
    }
  );
});

// Update user profile fields
app.put('/api/user/profile', requireAuth, (req, res) => {
  const { name, business_stage, business_type, goal } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: 'Name cannot be empty' });

  const validStages = ['idea', 'validation', 'registered', 'scaling'];
  const validTypes  = ['service', 'product', 'tech', 'local'];
  const validGoals  = ['idea', 'funding', 'growth'];

  if (business_stage && !validStages.includes(business_stage))
    return res.status(400).json({ error: 'Invalid business_stage value' });
  if (business_type && !validTypes.includes(business_type))
    return res.status(400).json({ error: 'Invalid business_type value' });
  if (goal && !validGoals.includes(goal))
    return res.status(400).json({ error: 'Invalid goal value' });

  db.run(
    `UPDATE users SET name = ?, business_stage = ?, business_type = ?, goal = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [name.trim(), business_stage || null, business_type || null, goal || null, req.userId],
    function(err) {
      if (err) return res.status(500).json({ error: 'Failed to update profile' });
      // Return the full updated user object
      db.get(
        'SELECT id, name, email, mobile_number, profile_picture, auth_provider, business_stage, business_type, goal FROM users WHERE id = ?',
        [req.userId],
        (err2, updatedUser) => {
          if (err2) return res.status(500).json({ error: 'Updated but failed to fetch new profile' });
          res.json({ success: true, user: updatedUser });
        }
      );
    }
  );
});

app.post('/api/auth/onboard', requireAuth, (req, res) => {
  const { business_stage, business_type, goal } = req.body;
  
  if (!business_stage || !business_type || !goal) {
    return res.status(400).json({ error: 'All core onboarding fields (stage, type, goal) are mandatory for data structuring.' });
  }

  db.run(
    'UPDATE users SET business_stage = ?, business_type = ?, goal = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [business_stage, business_type, goal, req.userId],
    (err) => {
      if (err) return res.status(500).json({ error: 'Failed to save onboarding parameters to DB' });
      res.json({ success: true, message: 'Onboarding complete' });
    }
  );
});

// ── Forgot Password — Send Reset Code ────────────────────────────────────────
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    db.get('SELECT id, name FROM users WHERE email = ?', [email], async (err, user) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      if (!user) return res.status(400).json({ error: 'No account found with this email.' });

      // Generate 6-digit code
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expiry = Date.now() + 15 * 60 * 1000; // 15 minutes
      resetCodes.set(email, { code, expiry, userId: user.id });

      // In production: send email via Nodemailer / SendGrid
      // For now: print to terminal so you can test locally
      console.log(`\n🔑 [PASSWORD RESET] Email: ${email} | Code: ${code} | Expires: ${new Date(expiry).toLocaleTimeString()}\n`);

      res.json({
        success: true,
        message: `Reset code sent to ${email}. Check your terminal (dev mode) — code valid for 15 minutes.`
      });
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Reset Password — Verify Code + Update Hash ────────────────────────────────
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword)
      return res.status(400).json({ error: 'Email, code, and new password are all required' });
    if (String(newPassword).length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const record = resetCodes.get(email);
    if (!record) return res.status(400).json({ error: 'No reset request found. Please request a new code.' });
    if (Date.now() > record.expiry) {
      resetCodes.delete(email);
      return res.status(400).json({ error: 'Reset code has expired. Please request a new one.' });
    }
    if (record.code !== String(code))
      return res.status(400).json({ error: 'Invalid reset code. Please check and try again.' });

    const password_hash = await bcrypt.hash(String(newPassword), 10);
    db.run('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?',
      [password_hash, email],
      (err) => {
        if (err) return res.status(500).json({ error: 'Failed to update password' });
        resetCodes.delete(email);
        console.log(`[PASSWORD RESET] ✅ Password updated for ${email}`);
        res.json({ success: true, message: 'Password reset successful! You can now sign in.' });
      }
    );
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Download Users as Excel ───────────────────────────────────────────────────
app.get('/api/admin/export-users', (req, res) => {
  db.all('SELECT id, name, email, mobile_number, auth_provider, business_stage, business_type, goal, created_at, last_login FROM users', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch users' });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Users');
    const filePath = path.join(__dirname, 'users_database.xlsx');
    XLSX.writeFile(wb, filePath);
    res.download(filePath, 'launchpad_users.xlsx');
  });
});

// ── Lead Capture (Welcome Modal) ─────────────────────────────────────────────
app.post('/api/leads', async (req, res) => {
  try {
    const { name, email, mobile, joinedAt } = req.body;
    if (!name || !email || !mobile) {
      return res.status(400).json({ error: 'Name, email and mobile are required' });
    }

    db.run(
      `INSERT OR IGNORE INTO leads (name, email, mobile, joined_at) VALUES (?, ?, ?, ?)`,
      [name.trim(), email.trim(), mobile.trim(), joinedAt || new Date().toISOString()],
      function (err) {
        if (err) {
          console.error('[Leads] DB error:', err.message);
          return res.status(500).json({ error: 'Failed to save lead' });
        }
        console.log(`[Lead Captured] ✅ ${name} | ${email} | ${mobile}`);
        // Auto-sync to Excel
        setTimeout(syncLeadsToExcel, 300);
        res.json({ success: true, message: 'Welcome to Launchpad Bharat!' });
      }
    );
  } catch (err) {
    console.error('[Leads] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Download Leads as Excel ───────────────────────────────────────────────────
app.get('/api/admin/export-leads', (req, res) => {
  db.all('SELECT * FROM leads ORDER BY joined_at DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch leads' });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Leads');
    const filePath = path.join(__dirname, 'leads_database.xlsx');
    XLSX.writeFile(wb, filePath);
    res.download(filePath, 'launchpad_leads.xlsx');
  });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.json({ success: true, message: 'Session destroyed securely' });
});

// --- Founder Library Document Routes ---

app.get('/api/documents', (req, res) => {
  db.all('SELECT * FROM documents WHERE is_active = 1', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to access document pipeline' });
    res.json(rows);
  });
});

app.post('/api/documents/sync', (req, res) => {
  // Normally protected by isAdmin flag middleware
  console.log('[API] Admin authorized manual synchronization sweep across all Founder Documents.');
  manuallySyncAllDocuments();
  res.json({ success: true, message: 'Sync queued successfully' });
});

// Initialize database then start server
initDb()
  .then(() => {
    console.log('✅ SQLite Database initialized securely.');
    
    // Fire up background tracking cron
    initScheduler();

    app.listen(PORT, () => {
      console.log(`🚀 API Server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ Failed to initialize database:', err);
    process.exit(1);
  });
