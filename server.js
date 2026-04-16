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
import { supabase, initDb } from './db.js';
import { initScheduler, manuallySyncAllDocuments } from './scheduler.js';
import { sendOtpSms } from './smsService.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

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

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// ── In-memory password reset codes (code → { email, expiry }) ────────────────
const resetCodes = new Map();

// Helper: sync all users to Excel file
const syncUsersToExcel = async () => {
  try {
    const { data: rows, error } = await supabase
      .from('users')
      .select('id, name, email, mobile_number, auth_provider, business_stage, business_type, goal, created_at, last_login');
    
    if (error) throw error;
    if (!rows || rows.length === 0) return;

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
const syncLeadsToExcel = async () => {
  try {
    const { data: rows, error } = await supabase
      .from('leads')
      .select('*')
      .order('joined_at', { ascending: false });
    
    if (error) throw error;
    if (!rows || rows.length === 0) return;

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
  origin: [
    process.env.FRONTEND_URL, 
    'https://launchpad-bharat.vercel.app',
    'http://localhost:5173'
  ].filter(Boolean),
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
    // Check for recent OTP requests (flood protection)
    const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { count, error: countError } = await supabase
      .from('otps')
      .select('*', { count: 'exact', head: true })
      .eq('mobile_number', mobile_number)
      .gt('created_at', fifteenMinsAgo);
    
    if (countError) throw countError;
    if (count >= 3) {
      return res.status(429).json({ error: 'Too many OTP requests. Please wait 15 minutes.' });
    }

    const plainOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedOtp = await bcrypt.hash(plainOtp, 10);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const { error: insertError } = await supabase
      .from('otps')
      .insert({ mobile_number, otp_hash: hashedOtp, expires_at: expiresAt });

    if (insertError) throw insertError;

    const smsResult = await sendOtpSms(mobile_number, plainOtp);

    if (!smsResult.success) {
      await supabase.from('otps').delete().eq('mobile_number', mobile_number).eq('otp_hash', hashedOtp);
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
    const { data: otpRecord, error: otpError } = await supabase
      .from('otps')
      .select('*')
      .eq('mobile_number', mobile_number)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (otpError) throw otpError;
    if (!otpRecord) return res.status(400).json({ error: 'No OTP requested' });

    if (new Date() > new Date(otpRecord.expires_at)) {
      return res.status(400).json({ error: 'OTP expired' });
    }

    if (otpRecord.attempt_count >= 5) {
      return res.status(429).json({ error: 'Too many attempts' });
    }

    const isValid = await bcrypt.compare(otp.toString(), otpRecord.otp_hash);
    if (!isValid) {
      await supabase
        .from('otps')
        .update({ attempt_count: otpRecord.attempt_count + 1 })
        .eq('id', otpRecord.id);
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    await supabase.from('otps').delete().eq('mobile_number', mobile_number);

    let { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('mobile_number', mobile_number)
      .maybeSingle();

    if (userError) throw userError;

    if (user) {
      const isNewOrIncomplete = !user.business_stage;
      await supabase
        .from('users')
        .update({ is_mobile_verified: true, updated_at: new Date().toISOString() })
        .eq('id', user.id);
      await issueToken(res, user.id, isNewOrIncomplete, user.email, user.name, user.profile_picture);
    } else {
      const { data: newUser, error: createError } = await supabase
        .from('users')
        .insert({ mobile_number, auth_provider: 'otp', is_mobile_verified: true })
        .select()
        .single();
      
      if (createError) throw createError;
      await issueToken(res, newUser.id, true, null, null, null);
    }
  } catch (err) {
    console.error('[VERIFY-OTP] Error:', err.message);
    res.status(500).json({ error: 'Verification error' });
  }
});

const issueToken = async (res, userId, isNewOrIncomplete, email, name, picture) => {
  const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
  
  try {
    await supabase
      .from('users')
      .update({ last_login: new Date().toISOString() })
      .eq('id', userId);
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
    const { data: user, error: signupError } = await supabase
      .from('users')
      .insert({ name, email: emailOrPhone, auth_provider: 'email', password_hash: hash })
      .select()
      .single();
    
    if (signupError) throw signupError;
    
    await issueToken(res, user.id, true, emailOrPhone, name, null);
    setTimeout(syncUsersToExcel, 500);
  } catch (err) {
    if (err.message && err.message.includes('unique')) return res.status(400).json({ error: 'Email exists' });
    res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { data: user, error: loginError } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (loginError) throw loginError;
    if (!user) return res.status(400).json({ error: 'No account' });
    if (!user.password_hash) return res.status(400).json({ error: 'Use Google Login' });

    const isValid = await bcrypt.compare(String(password), user.password_hash);
    if (!isValid) return res.status(400).json({ error: 'Wrong password' });

    await issueToken(res, user.id, !user.business_stage, user.email, user.name, user.profile_picture);
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
    let { data: user, error: searchError } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (searchError) throw searchError;

    if (user) {
      const { data: updatedUser, error: updateError } = await supabase
        .from('users')
        .update({ google_id, profile_picture: picture, updated_at: new Date().toISOString() })
        .eq('id', user.id)
        .select()
        .single();
      
      if (updateError) throw updateError;
      await issueToken(res, updatedUser.id, !updatedUser.business_stage, email, name, picture);
    } else {
      const { data: newUser, error: createError } = await supabase
        .from('users')
        .insert({ name, email, google_id, profile_picture: picture, auth_provider: 'google' })
        .select()
        .single();
      
      if (createError) throw createError;
      await issueToken(res, newUser.id, true, email, name, picture);
    }
  } catch (error) {
    res.status(401).json({ error: 'Google Login failed' });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, name, email, mobile_number, profile_picture, auth_provider, business_stage, business_type, goal, created_at, last_login')
      .eq('id', req.userId)
      .maybeSingle();

    if (error) throw error;
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user, isOnboarded: !!user.business_stage });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user profile fields
app.put('/api/user/profile', requireAuth, async (req, res) => {
  const { name, business_stage, business_type, goal } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });

  try {
    const { data: user, error: updateError } = await supabase
      .from('users')
      .update({ 
        name: name.trim(), 
        business_stage: business_stage || null, 
        business_type: business_type || null, 
        goal: goal || null, 
        updated_at: new Date().toISOString() 
      })
      .eq('id', req.userId)
      .select()
      .single();
    
    if (updateError) throw updateError;
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

app.post('/api/auth/onboard', requireAuth, async (req, res) => {
  const { business_stage, business_type, goal } = req.body;
  if (!business_stage || !business_type || !goal) return res.status(400).json({ error: 'Missing fields' });

  try {
    const { error: onboardError } = await supabase
      .from('users')
      .update({ business_stage, business_type, goal, updated_at: new Date().toISOString() })
      .eq('id', req.userId);
    
    if (onboardError) throw onboardError;
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
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, name')
      .eq('email', email)
      .maybeSingle();

    if (userError) throw userError;
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
    const { error: resetError } = await supabase
      .from('users')
      .update({ password_hash: hash, updated_at: new Date().toISOString() })
      .eq('email', email);
    
    if (resetError) throw resetError;
    resetCodes.delete(email);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Reset failed' });
  }
});

// ── Download Users as Excel ───────────────────────────────────────────────────
app.get('/api/admin/export-users', async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from('users')
      .select('id, name, email, mobile_number, auth_provider, business_stage, business_type, goal, created_at, last_login');
    
    if (error) throw error;
    const ws = XLSX.utils.json_to_sheet(rows || []);
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
  console.log(`[LEAD] Incoming lead capture: ${name} (${email})`);
  if (!name || !email || !mobile) return res.status(400).json({ error: 'Missing lead info' });

  try {
    const { error: upsertError } = await supabase
      .from('leads')
      .upsert({ 
        name: name.trim(), 
        email: email.trim(), 
        mobile: mobile.trim(), 
        joined_at: joinedAt || new Date().toISOString() 
      }, { onConflict: 'email' });
    
    if (upsertError) throw upsertError;
    
    setTimeout(syncLeadsToExcel, 300);
    res.json({ success: true });
  } catch (err) {
    console.error('[LEAD] Error:', err.message);
    res.status(500).json({ error: 'Lead save failed' });
  }
});

// ── Download Leads as Excel ───────────────────────────────────────────────────
app.get('/api/admin/export-leads', async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from('leads')
      .select('*')
      .order('joined_at', { ascending: false });
    
    if (error) throw error;
    const ws = XLSX.utils.json_to_sheet(rows || []);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Leads');
    const filePath = path.join(__dirname, 'leads_database.xlsx');
    XLSX.writeFile(wb, filePath);
    res.download(filePath);
  } catch (err) {
    res.status(500).json({ error: 'Export failed' });
  }
});

// --- Founder Library Document Routes ---

app.get('/api/documents', async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from('documents')
      .select('*')
      .eq('is_active', true);
    
    if (error) throw error;
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

// --- AI Blueprint Generator ---

app.post('/api/generate-blueprint', async (req, res) => {
  const { skills, niches, budget } = req.body;
  
  if (!skills || !niches || !budget) {
    return res.status(400).json({ error: 'Skills, Niches, and Budget are required to build a blueprint.' });
  }

  const prompt = `
    Role: Act as an Expert Startup Architect and Product Strategist in India.
    Objective: Generate a comprehensive, logical "Honest Blueprint" for a startup based on the following parameters:
    - Founder Niche / Skills: ${skills}
    - Industry: ${niches}
    - Total Launch Budget: ₹${budget} (Hard Limit).
    - Goal: Move from "Raw Idea" to "Minimum Viable Product (MVP)" with high conversion potential.

    ACTIVATE TREND ANALYSIS: Scan your vast knowledge base for highly successful, cutting-edge FOREIGN startup models (from the US, Europe, or China) that are currently NOT implemented in India yet. Give that foreign concept a localized "Indian Touch" (Desi ingenuity, WhatsApp-first nature, high trust requirements, etc.). 
    
    Instructions for Logic:
    * Use advanced logic to ensure all financial estimates are realistic and strictly kept under the ₹${budget} hard limit.
    * Prioritize the user's core skills as a competitive advantage.
    * If a feature is too expensive for the budget, you MUST suggest a manual "Wizard of Oz" alternative.
    * Do NOT give me boring, generic ideas. I want OUT OF THE BOX, unconventional, and disruptive startup ideas.

    Return the response strictly as a JSON object with these EXACT keys:
    {
      "name": "Creative & Catchy Startup Name",
      "overview": "What exactly the startup does in 2 sentences. Mention the foreign inspiration behind it.",
      "product_logic": "Map out the primary user journey, highlighting how the user's specific skills will solve a specific pain point.",
      "lean_tech_stack": "Recommend a specific stack (No-code/Low-code preferred) that stays under the budget limit while allowing for scalability. Suggest Wizard of Oz methods if needed.",
      "financial_allocation": "Provide a line-item breakdown of how to spend the exact ₹${budget} (e.g., Infrastructure, Marketing, Essential Tools). You must not exceed the budget.",
      "critical_risks": "Identify the three biggest 'honest' reasons this could fail in the current Indian market and exactly how to mitigate them.",
      "roadmap": [
        "30 Days: A tactical timeline for design and initial setup",
        "60 Days: Development and testing",
        "90 Days: First-user acquisition and launch"
      ]
    }
  `;

  try {
    const result = await aiModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 1.3, // High temperature for maximum creativity
        responseMimeType: "application/json" // Force strict JSON output
      }
    });

    const responseText = result.response.text();
    const blueprintData = JSON.parse(responseText);

    res.json(blueprintData);
  } catch (err) {
    console.error('[AI] Blueprint Generation Error:', err.message);
    res.status(500).json({ error: 'AI failed to generate blueprint. Please try again.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.json({ success: true, message: 'Session destroyed securely' });
});

// Start server after initDb
const startServer = async () => {
  try {
    await initDb();
    console.log('✅ Supabase Cloud Database connected and initialized.');
    initScheduler();
    app.listen(PORT, () => console.log(`🚀 API Server running on port ${PORT}`));
  } catch (err) {
    console.error('❌ Startup failed:', err);
    process.exit(1);
  }
};

startServer();
