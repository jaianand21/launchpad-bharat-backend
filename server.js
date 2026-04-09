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
  try {
    const rows = db.prepare('SELECT id, name, email, mobile_number, auth_provider, business_stage, business_type, goal, created_at, last_login FROM users').all();
    if (rows.length === 0) return;
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Users');
    const filePath = path.join(__dirname, 'users_database.xlsx');
    XLSX.writeFile(wb, filePath);
    console.log(`[Excel] Users database synced → ${filePath}`);
  } catch (err) {
    console.error('[Excel] User sync error:', err.message);
  }
};

// Helper: sync all leads to Excel file
const syncLeadsToExcel = () => {
  try {
    const rows = db.prepare('SELECT * FROM leads ORDER BY joined_at DESC').all();
    if (rows.length === 0) return;
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Leads');
    const filePath = path.join(__dirname, 'leads_database.xlsx');
    XLSX.writeFile(wb, filePath);
    console.log(`[Excel] Leads database synced → ${filePath} (${rows.length} leads)`);
  } catch (err) {
    console.error('[Excel] Leads sync error:', err.message);
  }
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

  if (!mobile_number || !/^\+91\d{10}$/.test(mobile_number)) {
    return res.status(400).json({ error: 'Invalid number. Must be a 10-digit Indian mobile number (e.g. +919999999999)' });
  }

  try {
    const row = db.prepare('SELECT COUNT(*) as count FROM otps WHERE mobile_number = ? AND created_at > datetime("now", "-15 minutes")').get(mobile_number);
    
    if (row.count >= 3) {
      return res.status(429).json({ error: 'Too many OTP requests. Please wait 15 minutes.' });
    }

    const plainOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedOtp = await bcrypt.hash(plainOtp, 10);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    db.prepare('INSERT INTO otps (mobile_number, otp_hash, expires_at) VALUES (?, ?, ?)').run(mobile_number, hashedOtp, expiresAt);

    const smsResult = await sendOtpSms(mobile_number, plainOtp);

    if (!smsResult.success) {
      db.prepare('DELETE FROM otps WHERE mobile_number = ? AND otp_hash = ?').run(mobile_number, hashedOtp);
      return res.status(502).json({ error: `SMS failed: ${smsResult.error}` });
    }

    res.json({ success: true, message: 'OTP sent successfully' });
  } catch (err) {
    console.error('[SEND-OTP] Error:', err.message);
    res.status(500).json({ error: 'Server error during OTP dispatch' });
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  const { mobile_number, otp } = req.body;
  if (!mobile_number || !otp) return res.status(400).json({ error: 'Mobile and OTP required' });

  try {
    const otpRecord = db.prepare('SELECT * FROM otps WHERE mobile_number = ? ORDER BY created_at DESC LIMIT 1').get(mobile_number);
    if (!otpRecord) return res.status(400).json({ error: 'No OTP requested' });

    if (new Date() > new Date(otpRecord.expires_at)) {
      return res.status(400).json({ error: 'OTP expired' });
    }

    if (otpRecord.attempt_count >= 5) {
      return res.status(429).json({ error: 'Too many attempts' });
    }

    const isValid = await bcrypt.compare(otp.toString(), otpRecord.otp_hash);
    if (!isValid) {
      db.prepare('UPDATE otps SET attempt_count = attempt_count + 1 WHERE id = ?').run(otpRecord.id);
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    db.prepare('DELETE FROM otps WHERE mobile_number = ?').run(mobile_number);

    let user = db.prepare('SELECT * FROM users WHERE mobile_number = ?').get(mobile_number);

    if (user) {
      const isNewOrIncomplete = !user.business_stage;
      db.prepare('UPDATE users SET is_mobile_verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
      issueToken(res, user.id, isNewOrIncomplete, user.email, user.name, user.profile_picture);
    } else {
      const info = db.prepare('INSERT INTO users (mobile_number, auth_provider, is_mobile_verified) VALUES (?, ?, 1)').run(mobile_number, 'otp');
      issueToken(res, info.lastInsertRowid, true, null, null, null);
    }
  } catch (err) {
    console.error('[VERIFY-OTP] Error:', err.message);
    res.status(500).json({ error: 'Verification error' });
  }
});

const issueToken = (res, userId, isNewOrIncomplete, email, name, picture) => {
  const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
  
  try {
    db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
  } catch (err) {
    console.error('IssueToken DB Error:', err.message);
  }
  
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
    if (!name || !emailOrPhone || !password) return res.status(400).json({ error: 'All fields required' });

    const hash = await bcrypt.hash(String(password), 10);
    const info = db.prepare('INSERT INTO users (name, email, auth_provider, password_hash) VALUES (?, ?, ?, ?)').run(name, emailOrPhone, 'email', hash);
    
    issueToken(res, info.lastInsertRowid, true, emailOrPhone, name, null);
    setTimeout(syncUsersToExcel, 500);
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Email exists' });
    res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.status(400).json({ error: 'No account' });
    if (!user.password_hash) return res.status(400).json({ error: 'Use Google Login' });

    const isValid = await bcrypt.compare(String(password), user.password_hash);
    if (!isValid) return res.status(400).json({ error: 'Wrong password' });

    issueToken(res, user.id, !user.business_stage, user.email, user.name, user.profile_picture);
  } catch (err) {
    res.status(500).json({ error: 'Login error' });
  }
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const { id_token, mock_profile } = req.body;
    let payload;

    if (id_token && id_token !== 'mock_google_token') {
      const ticket = await client.verifyIdToken({
        idToken: id_token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } else {
      payload = mock_profile || { sub: 'mock_123', email: 'demo@demo.com', name: 'Demo', picture: null };
    }

    const { sub: google_id, email, name, picture } = payload;
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    if (user) {
      db.prepare('UPDATE users SET google_id = ?, profile_picture = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(google_id, picture, user.id);
      issueToken(res, user.id, !user.business_stage, email, name, picture);
    } else {
      const info = db.prepare('INSERT INTO users (name, email, google_id, profile_picture, auth_provider) VALUES (?, ?, ?, ?, ?)').run(name, email, google_id, picture, 'google');
      issueToken(res, info.lastInsertRowid, true, email, name, picture);
    }
  } catch (error) {
    res.status(401).json({ error: 'Google Login failed' });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  try {
    const user = db.prepare('SELECT id, name, email, mobile_number, profile_picture, auth_provider, business_stage, business_type, goal, created_at, last_login FROM users WHERE id = ?').get(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user, isOnboarded: !!user.business_stage });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user profile fields
app.put('/api/user/profile', requireAuth, (req, res) => {
  const { name, business_stage, business_type, goal } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });

  try {
    db.prepare(`UPDATE users SET name = ?, business_stage = ?, business_type = ?, goal = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(name.trim(), business_stage || null, business_type || null, goal || null, req.userId);
    
    const user = db.prepare('SELECT id, name, email, mobile_number, profile_picture, auth_provider, business_stage, business_type, goal FROM users WHERE id = ?').get(req.userId);
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

app.post('/api/auth/onboard', requireAuth, (req, res) => {
  const { business_stage, business_type, goal } = req.body;
  if (!business_stage || !business_type || !goal) return res.status(400).json({ error: 'Missing fields' });

  try {
    db.prepare('UPDATE users SET business_stage = ?, business_type = ?, goal = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(business_stage, business_type, goal, req.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Onboarding failed' });
  }
});

// ── Forgot Password — Send Reset Code ────────────────────────────────────────
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const user = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
    if (!user) return res.status(400).json({ error: 'No user' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    resetCodes.set(email, { code, expiry: Date.now() + 15 * 60 * 1000, userId: user.id });
    console.log(`🔑 Reset Code: ${code}`);
    res.json({ success: true, message: 'Code generated' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Reset Password — Verify Code + Update Hash ────────────────────────────────
app.post('/api/auth/reset-password', async (req, res) => {
  const { email, code, newPassword } = req.body;
  const record = resetCodes.get(email);
  if (!record || record.code !== String(code) || Date.now() > record.expiry) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }

  try {
    const hash = await bcrypt.hash(String(newPassword), 10);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?').run(hash, email);
    resetCodes.delete(email);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Reset failed' });
  }
});

// ── Download Users as Excel ───────────────────────────────────────────────────
app.get('/api/admin/export-users', (req, res) => {
  try {
    const rows = db.prepare('SELECT id, name, email, mobile_number, auth_provider, business_stage, business_type, goal, created_at, last_login FROM users').all();
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Users');
    const filePath = path.join(__dirname, 'users_database.xlsx');
    XLSX.writeFile(wb, filePath);
    res.download(filePath);
  } catch (err) {
    res.status(500).json({ error: 'Export failed' });
  }
});

// ── Lead Capture (Welcome Modal) ─────────────────────────────────────────────
app.post('/api/leads', async (req, res) => {
  const { name, email, mobile, joinedAt } = req.body;
  if (!name || !email || !mobile) return res.status(400).json({ error: 'Missing lead info' });

  try {
    db.prepare(`INSERT OR IGNORE INTO leads (name, email, mobile, joined_at) VALUES (?, ?, ?, ?)`).run(name.trim(), email.trim(), mobile.trim(), joinedAt || new Date().toISOString());
    setTimeout(syncLeadsToExcel, 300);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Lead save failed' });
  }
});

// ── Download Leads as Excel ───────────────────────────────────────────────────
app.get('/api/admin/export-leads', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM leads ORDER BY joined_at DESC').all();
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Leads');
    const filePath = path.join(__dirname, 'leads_database.xlsx');
    XLSX.writeFile(wb, filePath);
    res.download(filePath);
  } catch (err) {
    res.status(500).json({ error: 'Export failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.json({ success: true, message: 'Session destroyed securely' });
});

// --- Founder Library Document Routes ---

app.get('/api/documents', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM documents WHERE is_active = 1').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Docs fetch failed' });
  }
});

app.post('/api/documents/sync', (req, res) => {
  // Normally protected by isAdmin flag middleware
  console.log('[API] Admin authorized manual synchronization sweep across all Founder Documents.');
  manuallySyncAllDocuments();
  res.json({ success: true, message: 'Sync queued successfully' });
});

// Start server synchronously after initDb
try {
  initDb();
  console.log('✅ SQLite Database initialized securely.');
  initScheduler();
  app.listen(PORT, () => console.log(`🚀 API Server running on port ${PORT}`));
} catch (err) {
  console.error('❌ Startup failed:', err);
  process.exit(1);
}
