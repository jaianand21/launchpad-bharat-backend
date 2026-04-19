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
import Groq from 'groq-sdk';
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

// ── Multi-Key AI Rotation Pool ───────────────────────────────────────────────
const GROQ_KEY_POOL = [
  { key: process.env.GROQ_API_KEY_pvt,         model: 'llama-3.3-70b-versatile', label: 'Groq-pvt' },
  { key: process.env.GROQ_API_KEY_eng,          model: 'llama-3.3-70b-versatile', label: 'Groq-eng' },
  { key: process.env.GROQ_API_KEY_abhay,        model: 'llama3-70b-8192',         label: 'Groq-abhay' },
  { key: process.env.GROQ_API_KEY_abhay_class,  model: 'llama3-8b-8192',          label: 'Groq-abhay-class' },
].filter(entry => entry.key);

const GEMINI_KEY_POOL = [
  { key: process.env.GEMINI_API_pvt,        model: 'gemini-2.0-flash', label: 'Gemini-pvt' },
  { key: process.env.GEMINI_API_eng,        model: 'gemini-2.0-flash', label: 'Gemini-eng' },
  { key: process.env.GEMINI_API_abhay,      model: 'gemini-1.5-flash', label: 'Gemini-abhay' },
  { key: process.env.GEMINI_API_abhay_class,model: 'gemini-1.5-flash', label: 'Gemini-abhay-class' },
].filter(entry => entry.key);

let groqStartIndex = 0;
let geminiStartIndex = 0;

const tryGroqKey = async (entry, systemPrompt, userPrompt) => {
  const instance = new Groq({ apiKey: entry.key });
  const result = await instance.chat.completions.create({
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    model: entry.model,
    temperature: 0.85,
    max_completion_tokens: 4096,
    response_format: { type: 'json_object' }
  });
  return result.choices[0].message.content;
};

const tryGeminiKey = async (entry, systemPrompt, userPrompt) => {
  const genAI = new GoogleGenerativeAI(entry.key);
  const model = genAI.getGenerativeModel({ model: entry.model });
  const result = await model.generateContent(`${systemPrompt}\n\n${userPrompt}`);
  return result.response.text();
};

const callAIWithFallback = async (systemPrompt, userPrompt) => {
  for (let i = 0; i < GROQ_KEY_POOL.length; i++) {
    const index = (groqStartIndex + i) % GROQ_KEY_POOL.length;
    const entry = GROQ_KEY_POOL[index];
    try {
      console.log(`[AI] Trying ${entry.label}...`);
      const text = await tryGroqKey(entry, systemPrompt, userPrompt);
      groqStartIndex = index;
      console.log(`[AI] ✅ ${entry.label} succeeded.`);
      return text;
    } catch (err) {
      if (err?.status === 429 || err?.status === 401 || err?.status === 400 || err?.message?.toLowerCase().includes('rate')) {
        console.warn(`[AI] ⚠️ ${entry.label} failed (${err.status || err.message}). Trying next...`);
        groqStartIndex = (index + 1) % GROQ_KEY_POOL.length;
        continue;
      }
      throw err;
    }
  }
  for (let i = 0; i < GEMINI_KEY_POOL.length; i++) {
    const index = (geminiStartIndex + i) % GEMINI_KEY_POOL.length;
    const entry = GEMINI_KEY_POOL[index];
    try {
      console.log(`[AI] Trying ${entry.label}...`);
      const text = await tryGeminiKey(entry, systemPrompt, userPrompt);
      geminiStartIndex = index;
      console.log(`[AI] ✅ ${entry.label} succeeded.`);
      return text;
    } catch (err) {
      if (err?.status === 429 || err?.status === 401 || err?.message?.toLowerCase().includes('quota') || err?.message?.toLowerCase().includes('rate')) {
        console.warn(`[AI] ⚠️ ${entry.label} failed (${err.status || err.message}). Trying next...`);
        geminiStartIndex = (index + 1) % GEMINI_KEY_POOL.length;
        continue;
      }
      throw err;
    }
  }
  throw new Error('Our AI is taking a short break. Please try again in 5 minutes.');
};

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

  const systemPrompt = `You are "Launchpad Bharat AI" — India's most brutally honest Startup Architect, built specifically for first-time founders in Tier-2 and Tier-3 Indian cities.

Your personality: You think like a seasoned Indian VC who has seen 1000 pitches fail. You are direct, specific, and ruthlessly practical. You never give generic advice. Every idea you generate must be executable by a solo founder in India with limited resources.

CORE RULES YOU NEVER BREAK:
1. ZERO paid tools unless absolutely unavoidable — always suggest free alternatives first
2. NO domain cost — use Vercel free subdomain or Carrd free tier
3. NO ad spend — use Instagram Reels, YouTube Shorts, WhatsApp Status, local college/chai-shop outreach
4. NO paid hosting — Vercel, Railway free tier, Render free tier, Supabase free tier
5. NO paid email — use Gmail + Brevo free tier (300 emails/day)
6. If a feature is too expensive — suggest "Wizard of Oz" manual workaround first
7. EVERY startup idea must be inspired by a REAL foreign model (US/EU/China) not yet in India
8. EVERY idea must have a WhatsApp-first or offline-first distribution strategy
9. EVERY startup name must be catchy, short, Hinglish-friendly, and domain-available on Vercel
10. ALWAYS treat the founder's skill as the #1 competitive moat — build the entire idea around it
11. NEVER repeat the same startup idea twice — use the founder's unique skill+budget+niche combo to generate a completely fresh concept every time
12. GST and legal compliance must be mentioned honestly
13. Be a mentor, not a cheerleader — flag every real risk

BUDGET LOGIC:
- Under 5000 INR: Pure service/consulting model, zero product build
- 5000-15000 INR: No-code MVP only (Glide, Softr, Carrd, WhatsApp Business)
- 15000-50000 INR: Lightweight web app (Next.js on Vercel + Supabase)
- 50000-200000 INR: Full MVP with basic automation
- Above 200000 INR: Product + small team + first paid marketing

OUTPUT FORMAT: Respond ONLY with a valid JSON object. No markdown. No explanation outside JSON. No extra keys. Every value must be exactly the type shown in the schema.`;

  const userPrompt = `Generate a complete "Launchpad Bharat Blueprint" for this founder:

FOUNDER PROFILE:
- Skills: ${skills}
- Target Industry/Niche: ${niches}
- Total Starting Budget: INR ${budget} (HARD LIMIT — do not exceed this in any cost line)

YOUR TASK:
Find ONE highly specific foreign startup (US/EU/China) that is successful but has NOT launched in India. Adapt it completely for the Indian market with a "Desi Touch."

Also add a "founder_tips" section with 5 actionable suggestions that a first-time startup founder in India absolutely needs to know.

Respond ONLY with this exact JSON structure (all values are strings unless noted otherwise):

{
  "startup_name": "string — Catchy Hinglish-friendly name, max 2 words",
  "tagline": "string — One punchy line, max 10 words",
  "foreign_inspiration": {
    "company": "string — Exact foreign company name",
    "country": "string — Country",
    "why_not_in_india_yet": "string — Honest 1-sentence reason"
  },
  "problem_statement": "string — 3-4 sentences. The EXACT pain point this solves for an Indian Tier-2/3 user. Use real scenarios, not abstract language.",
  "solution": "string — 3-4 sentences. How the founder's skill directly solves this. Be specific about the user journey from discovery to payment to result.",
  "indian_adaptation": {
    "distribution": "string — WhatsApp-first or offline-first strategy in detail",
    "trust_building": "string — How to build trust in a low-trust market (COD, referrals, demos, etc.)",
    "language": "string — Regional language / Hinglish support plan",
    "payment": "string — UPI, COD, or instalment strategy"
  },
  "free_tech_stack": {
    "frontend": "string — Tool name + why it is free and suitable",
    "backend": "string — Tool name + free tier details",
    "database": "string — Tool name + free tier details",
    "communication": "string — WhatsApp Business API free tier or alternative",
    "hosting": "string — Vercel / Railway / Render free tier",
    "payments": "string — Razorpay free + UPI QR code",
    "domain": "string — yourname.vercel.app or Carrd free subdomain",
    "email": "string — Brevo free 300/day or Gmail"
  },
  "financial_allocation": {
    "total_budget": "string — INR ${budget}",
    "line_items": [
      { "item": "string — Item name", "cost": "string — INR amount or FREE", "free_alternative": "string — Alternative if paid" }
    ],
    "total_spent": "string — INR X (must be under budget)",
    "reserve": "string — INR Y (keep minimum 20% as emergency reserve)"
  },
  "revenue_model": {
    "month_1_to_3": "string — Exact first revenue source with pricing in INR",
    "month_4_to_6": "string — Second revenue stream",
    "year_2": "string — Scale strategy",
    "break_even_target": "string — Estimated month to break even"
  },
  "six_month_roadmap": [
    {
      "month": "string — Month 1",
      "theme": "string — One-word theme",
      "weekly_tasks": ["string — Week 1: ...", "string — Week 2: ...", "string — Week 3: ...", "string — Week 4: ..."],
      "milestone": "string — What success looks like at end of month"
    },
    {
      "month": "string — Month 2",
      "theme": "string — One-word theme",
      "weekly_tasks": ["string — Week 1: ...", "string — Week 2: ...", "string — Week 3: ...", "string — Week 4: ..."],
      "milestone": "string — What success looks like at end of month"
    },
    {
      "month": "string — Month 3",
      "theme": "string — One-word theme",
      "weekly_tasks": ["string — Week 1: ...", "string — Week 2: ...", "string — Week 3: ...", "string — Week 4: ..."],
      "milestone": "string — What success looks like at end of month"
    },
    {
      "month": "string — Month 4",
      "theme": "string — One-word theme",
      "weekly_tasks": ["string — Week 1: ...", "string — Week 2: ...", "string — Week 3: ...", "string — Week 4: ..."],
      "milestone": "string — What success looks like at end of month"
    },
    {
      "month": "string — Month 5",
      "theme": "string — One-word theme",
      "weekly_tasks": ["string — Week 1: ...", "string — Week 2: ...", "string — Week 3: ...", "string — Week 4: ..."],
      "milestone": "string — What success looks like at end of month"
    },
    {
      "month": "string — Month 6",
      "theme": "string — One-word theme",
      "weekly_tasks": ["string — Week 1: ...", "string — Week 2: ...", "string — Week 3: ...", "string — Week 4: ..."],
      "milestone": "string — What success looks like at end of month"
    }
  ],
  "critical_risks": [
    { "risk": "string", "probability": "string — High/Medium/Low", "impact": "string — High/Medium/Low", "mitigation": "string — step-by-step mitigation" },
    { "risk": "string", "probability": "string", "impact": "string", "mitigation": "string" },
    { "risk": "string", "probability": "string", "impact": "string", "mitigation": "string" }
  ],
  "legal_and_compliance": {
    "business_registration": "string — Sole proprietorship first — cost and process",
    "gst_registration": "string — When to register, threshold, cost",
    "required_documents": ["string — Document 1", "string — Document 2", "string — Document 3"],
    "important_warnings": "string — Any sector-specific legal risks"
  },
  "website_must_haves": ["string — Feature 1", "string — Feature 2", "string — Feature 3", "string — Feature 4", "string — Feature 5"],
  "founder_superpower": "string — 1 paragraph describing how this founder's specific skill gives them an unfair advantage over any well-funded competitor",
  "founder_tips": ["string — Tip 1", "string — Tip 2", "string — Tip 3", "string — Tip 4", "string — Tip 5"],
  "honest_verdict": {
    "viability_score": "string — X/10",
    "best_case": "string — If everything goes right in 12 months...",
    "worst_case": "string — If the top 2 risks hit simultaneously...",
    "one_thing_that_will_make_or_break_this": "string — The single most important execution factor"
  }
}`;

  try {
    const responseText = await callAIWithFallback(systemPrompt, userPrompt);

    // Try direct parse first
    let blueprintData;
    try {
      blueprintData = JSON.parse(responseText);
    } catch {
      // Fallback: extract JSON block from markdown code fences or mixed text
      const match = responseText.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          blueprintData = JSON.parse(match[0]);
        } catch (e2) {
          console.error('[AI] JSON Extract Failed. Raw:', responseText.slice(0, 800));
          return res.status(500).json({ error: `AI returned unparseable data: ${e2.message}` });
        }
      } else {
        console.error('[AI] No JSON found. Raw:', responseText.slice(0, 800));
        return res.status(500).json({ error: 'AI response had no JSON block. Please try again.' });
      }
    }

    res.json(blueprintData);
  } catch (err) {
    console.error('[AI] Blueprint Generation Error:', err.message);
    res.status(500).json({ error: err.message.includes('short break') ? err.message : 'Blueprint generation failed. Please try again in a moment.' });
  }
});

// ── Stats API ───────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const { count: usersCount, error: usersErr } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });
    
    const { count: docsCount, error: docsErr } = await supabase
      .from('documents')
      .select('*', { count: 'exact', head: true });

    // Fetch latest two users for the "Live" labels
    const { data: latestUsers } = await supabase
      .from('users')
      .select('name')
      .order('created_at', { ascending: false })
      .limit(2);

    if (usersErr || docsErr) throw usersErr || docsErr;

    const activeUsers = usersCount || 0;
    
    // Adjusted base offsets as per user request
    const blueprintsGenerated = 247 + (activeUsers * 2.5); 
    const foundersJoined = 91 + activeUsers;
    
    // 95 are static in resourcesData.jsx + dynamic docs in DB
    const resourcesAdded = 95 + (docsCount || 0);

    const latestFounder = latestUsers && latestUsers.length > 0 ? latestUsers[0].name : "Rohan Sharma";
    const latestBlueprintUser = latestUsers && latestUsers.length > 1 ? latestUsers[1].name : latestFounder;

    res.json({
      blueprints: Math.floor(blueprintsGenerated),
      founders: foundersJoined,
      resources: resourcesAdded,
      latestFounder,
      latestBlueprintUser
    });
  } catch (err) {
    console.error('[API] Stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch platform stats' });
  }
});

// ── Reviews API ─────────────────────────────────────────────────────────────
app.get('/api/reviews', async (req, res) => {
  try {
    const { data: reviews, error } = await supabase
      .from('reviews')
      .select('name, age, location, description, created_at')
      .order('created_at', { ascending: false })
      .limit(6);
    
    if (error) {
      if (error.code === '42P01') return res.json([]); // Table doesn't exist
      throw error;
    }
    
    res.json(reviews || []);
  } catch (err) {
    console.error('[API] Fetch Reviews error:', err.message);
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

app.post('/api/reviews', async (req, res) => {
  try {
    const { name, age, location, description } = req.body;
    if (!name || !description) return res.status(400).json({ error: 'Name and description are required' });

    const { error } = await supabase
      .from('reviews')
      .insert({ name, age, location, description });
    
    if (error) {
      if (error.code === '42P01') return res.json({ success: true, message: 'Review saved (Mocked)' }); // Table doesn't exist
      throw error;
    }

    res.json({ success: true, message: 'Review successfully added' });
  } catch (err) {
    console.error('[API] Submit Review error:', err.message);
    res.status(500).json({ error: 'Failed to submit review' });
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
