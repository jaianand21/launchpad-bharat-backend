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
import { sendResetEmail } from './mailService.js';
import Groq from 'groq-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import validator from 'validator';
import crypto from 'crypto';
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
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// ── Security Headers ─────────────────────────────────────────────────────────
app.use(helmet());

// ── Global Rate Limiter (100 requests per 15 min per IP) ─────────────────────
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false }));

// ── Strict Rate Limiters for sensitive endpoints ─────────────────────────────
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15, message: { error: 'Too many attempts. Please try again in 15 minutes.' } });
const aiLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'AI generation limit reached. Please try again in an hour.' } });
const reviewLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { error: 'Review submission limit reached.' } });

// Global Request Logger
app.use((req, res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.url} - ${new Date().toISOString()}`);
  next();
});

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ── Multi-Key AI Rotation Pool ───────────────────────────────────────────────
const GROQ_KEY_POOL = [
  { key: process.env.GROQ_API_KEY_pvt, model: 'llama-3.3-70b-versatile', label: 'Groq-pvt' },
  { key: process.env.GROQ_API_KEY_eng, model: 'llama-3.3-70b-versatile', label: 'Groq-eng' },
  { key: process.env.GROQ_API_KEY_3 || process.env.GROQ_API_KEY_abhay,   model: 'llama-3.3-70b-versatile',         label: 'Groq-pool3' },
  { key: process.env.GROQ_API_KEY_4 || process.env.GROQ_API_KEY_abhay_class,   model: 'llama-3.3-70b-versatile',          label: 'Groq-pool4' },
].filter(entry => entry.key);

const GEMINI_KEY_POOL = [
  { key: process.env.GEMINI_API_pvt, model: 'gemini-3.6-flash', label: 'Gemini-pvt' },
  { key: process.env.GEMINI_API_eng, model: 'gemini-3.6-flash', label: 'Gemini-eng' },
  { key: process.env.GEMINI_API_3 || process.env.GEMINI_API_abhay,   model: 'gemini-3.6-flash', label: 'Gemini-pool3' },
  { key: process.env.GEMINI_API_4 || process.env.GEMINI_API_abhay_class,   model: 'gemini-3.6-flash', label: 'Gemini-pool4' },
].filter(entry => entry.key);

let groqStartIndex = 0;
let geminiStartIndex = 0;

const tryGroqKey = async (entry, systemPrompt, userPrompt, json = true) => {
  const instance = new Groq({ apiKey: entry.key });
  const params = {
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    model: entry.model,
    temperature: 0.95, // Increased to ensure unique ideas
    max_completion_tokens: 4096
  };
  if (json) {
    params.response_format = { type: 'json_object' };
  }
  const result = await instance.chat.completions.create(params);
  return result.choices[0].message.content;
};

const tryGeminiKey = async (entry, systemPrompt, userPrompt, json = true) => {
  const genAI = new GoogleGenerativeAI(entry.key);
  const generationConfig = { temperature: 0.95 };
  if (json) {
    generationConfig.responseMimeType = "application/json";
  }
  const model = genAI.getGenerativeModel({ 
    model: entry.model, 
    generationConfig
  });
  const result = await model.generateContent(`${systemPrompt}\n\n${userPrompt}`);
  return result.response.text();
};

const callAIWithFallback = async (systemPrompt, userPrompt, json = true) => {
  for (let i = 0; i < GROQ_KEY_POOL.length; i++) {
    const index = (groqStartIndex + i) % GROQ_KEY_POOL.length;
    const entry = GROQ_KEY_POOL[index];
    console.log(`[AI] Attempting Groq key: ${entry.label} (${index+1}/${GROQ_KEY_POOL.length})`);
    try {
      console.log(`[AI] Trying ${entry.label}...`);
      const data = await tryGroqKey(entry, systemPrompt, userPrompt, json);
      console.log(`[AI] SUCCESS: Groq key ${entry.label} worked.`);
      groqStartIndex = index;
      return data;
    } catch (err) {
      console.warn(`[AI] FAILED: Groq key ${entry.label} error: ${err.message}`);
      console.warn(`[AI] ⚠️ ${entry.label} failed. Trying next...`);
      groqStartIndex = (index + 1) % GROQ_KEY_POOL.length;
      continue;
    }
  }
  for (let i = 0; i < GEMINI_KEY_POOL.length; i++) {
    const index = (geminiStartIndex + i) % GEMINI_KEY_POOL.length;
    const entry = GEMINI_KEY_POOL[index];
    console.log(`[AI] Falling back to Gemini key: ${entry.label} (${index+1}/${GEMINI_KEY_POOL.length})`);
    try {
      console.log(`[AI] Trying ${entry.label}...`);
      const data = await tryGeminiKey(entry, systemPrompt, userPrompt, json);
      console.log(`[AI] SUCCESS: Gemini key ${entry.label} worked.`);
      geminiStartIndex = index;
      return data;
    } catch (err) {
      console.warn(`[AI] FAILED: Gemini key ${entry.label} error: ${err.message}`);
      console.warn(`[AI] ⚠️ ${entry.label} failed. Trying next...`);
      geminiStartIndex = (index + 1) % GEMINI_KEY_POOL.length;
      continue;
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

// ── CORS — only allow localhost in development ──────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://launchpad-bharat.vercel.app'
].filter(Boolean);
if (!IS_PRODUCTION) allowedOrigins.push('http://localhost:5173');

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

app.use(express.json());
app.use(cookieParser());

// --- Authentication Middleware ---
const requireAuth = (req, res, next) => {
  let token = req.cookies?.auth_token;
  if (!token && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      token = parts[1];
    }
  }

  if (!token) return res.status(401).json({ error: 'AUTH_TOKEN_MISSING' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    req.user = { id: decoded.userId };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'AUTH_TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'AUTH_TOKEN_INVALID' });
  }
};

// --- Admin Authorization Middleware ---
const requireAdmin = (req, res, next) => {
  let token = req.cookies?.auth_token;
  if (!token && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      token = parts[1];
    }
  }

  if (!token) return res.status(401).json({ error: 'AUTH_TOKEN_MISSING' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const adminIds = (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (adminIds.length > 0 && !adminIds.includes(String(decoded.userId))) {
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }
    req.userId = decoded.userId;
    req.user = { id: decoded.userId };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'AUTH_TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'AUTH_TOKEN_INVALID' });
  }
};

const FREE_BLUEPRINT_LIMIT = 3;
const FREE_CHAT_LIMIT = 5;

// Middleware to verify plan and blueprint generation limits
const planCheckMiddleware = async (req, res, next) => {
  const userId = req.userId;

  if (!supabase) {
    return next();
  }

  try {
    await supabase.rpc('set_config', { key: 'app.current_user_id', value: String(userId) });
  } catch (rpcErr) {
    console.warn('[PLAN_CHECK] Failed to set app.current_user_id via RPC:', rpcErr.message);
  }

  try {
    let { data: plan, error } = await supabase
      .from('user_plans')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    // Auto-create plan row for users with no plan row
    if (!plan || (error && error.code === 'PGRST116')) {
      const { data: newPlan, error: insertError } = await supabase
        .from('user_plans')
        .insert({ user_id: userId, plan: 'free', blueprint_count_this_month: 0 })
        .select()
        .single();
      if (insertError) {
        console.error('[PLAN_INIT_FAILED] error:', insertError.message);
        return res.status(500).json({ error: 'PLAN_INIT_FAILED' });
      }
      plan = newPlan;
    } else if (error) {
      console.error('[PLAN_CHECK] database error:', error.message);
      return res.status(500).json({ error: 'PLAN_CHECK_FAILED' });
    }

    if (plan.plan === 'free' && plan.blueprint_count_this_month >= FREE_BLUEPRINT_LIMIT) {
      return res.status(403).json({
        error: 'PAYWALL_LIMIT_REACHED',
        used: plan.blueprint_count_this_month,
        limit: FREE_BLUEPRINT_LIMIT,
        message: `You have generated ${FREE_BLUEPRINT_LIMIT}/${FREE_BLUEPRINT_LIMIT} free blueprints this month. Upgrade to Premium for unlimited access.`
      });
    }

    req.userPlan = plan;
    next();
  } catch (err) {
    console.error('[PLAN_CHECK] Unexpected error:', err.message);
    res.status(500).json({ error: 'Server error during plan check' });
  }
};

// Middleware to restrict free chat session limit
const chatLimitMiddleware = async (req, res, next) => {
  const userId = req.userId;

  if (!supabase) {
    return next();
  }

  try {
    await supabase.rpc('set_config', { key: 'app.current_user_id', value: String(userId) });
  } catch (rpcErr) {
    console.warn('[CHAT_LIMIT] Failed to set app.current_user_id via RPC:', rpcErr.message);
  }

  try {
    let { data: plan, error } = await supabase
      .from('user_plans')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    // Auto-create plan row for users with no plan row
    if (!plan || (error && error.code === 'PGRST116')) {
      const { data: newPlan, error: insertError } = await supabase
        .from('user_plans')
        .insert({ user_id: userId, plan: 'free', chat_message_count_this_session: 0 })
        .select()
        .single();
      if (insertError) {
        console.error('[PLAN_INIT_FAILED] error:', insertError.message);
        return res.status(500).json({ error: 'PLAN_INIT_FAILED' });
      }
      plan = newPlan;
    } else if (error) {
      console.error('[CHAT_LIMIT] database error:', error.message);
      return res.status(500).json({ error: 'CHAT_LIMIT_FAILED' });
    }

    if (plan.plan === 'free' && plan.chat_message_count_this_session >= FREE_CHAT_LIMIT) {
      return res.status(403).json({
        error: 'CHAT_LIMIT_REACHED',
        used: plan.chat_message_count_this_session,
        limit: FREE_CHAT_LIMIT,
        message: 'You have used 5/5 free chat messages. Upgrade to Premium for unlimited AI Architect access.'
      });
    }

    // Increment chat message count
    const { error: updateError } = await supabase
      .from('user_plans')
      .update({ chat_message_count_this_session: plan.chat_message_count_this_session + 1 })
      .eq('user_id', userId);

    if (updateError) {
      console.error('[CHAT_LIMIT] Failed to increment count:', updateError.message);
    }

    req.userPlan = plan;
    next();
  } catch (err) {
    console.error('[CHAT_LIMIT] Unexpected error:', err.message);
    res.status(500).json({ error: 'Server error during chat check' });
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

    // Check if user exists with this mobile number
    let { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('mobile_number', mobile_number)
      .maybeSingle();

    if (userError) {
      console.error('[DB] User fetch error:', userError.message);
      return res.status(500).json({ error: 'Database error during lookup' });
    }

    if (userError) throw userError;

    if (user) {
      const isNewOrIncomplete = !user.business_stage;
      await supabase
        .from('users')
        .update({ 
          is_mobile_verified: true, 
          updated_at: new Date().toISOString(),
          last_login: new Date().toISOString()
        })
        .eq('id', user.id);
      await issueToken(res, user.id, isNewOrIncomplete, user.email, user.name, user.profile_picture);
    } else {
      const { data: newUser, error: createError } = await supabase
        .from('users')
        .insert({ 
          mobile_number, 
          auth_provider: 'otp', 
          is_mobile_verified: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
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
    secure: IS_PRODUCTION,
    sameSite: IS_PRODUCTION ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });

  res.json({
    success: true,
    token,
    isNewUser: isNewOrIncomplete,
    user: { id: userId, email, name, picture }
  });
};

app.post('/api/auth/signup', authLimiter, async (req, res) => {
  try {
    const { name, emailOrPhone, password } = req.body;
    if (!name || !emailOrPhone || !password) return res.status(400).json({ error: 'All fields required' });

    // Input validation
    const safeName = validator.escape(String(name).trim().slice(0, 100));
    if (!validator.isEmail(String(emailOrPhone))) return res.status(400).json({ error: 'Invalid email format' });
    if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const hash = await bcrypt.hash(String(password), 10);
    const { data: user, error: signupError } = await supabase
      .from('users')
      .insert({ name: safeName, email: emailOrPhone.trim(), auth_provider: 'email', password_hash: hash })
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

app.post('/api/auth/login', authLimiter, async (req, res) => {
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

app.post('/api/auth/google', authLimiter, async (req, res) => {
  try {
    const { id_token, mock_profile } = req.body;
    let payload;

    // Only allow mock auth in development — NEVER in production
    if (!IS_PRODUCTION && id_token === 'mock_google_token') {
      payload = mock_profile || { sub: 'mock_123', email: 'demo@demo.com', name: 'Demo', picture: null };
    } else if (id_token) {
      const ticket = await client.verifyIdToken({
        idToken: id_token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } else {
      return res.status(400).json({ error: 'Missing authentication token' });
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
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
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
    // Only log reset code in development — NEVER in production
    if (!IS_PRODUCTION) console.log(`🔑 [DEV ONLY] Reset Code: ${code}`);
    
    // Attempt to send the email
    const emailResult = await sendResetEmail(email, code);
    if (!emailResult.success) {
      // If email fails in production, we should let the user know. 
      // In development, we might still want to proceed if they just want to see the console log.
      if (IS_PRODUCTION) {
        return res.status(502).json({ error: 'Failed to send reset email. Please try again later.' });
      } else {
        console.warn(`[DEV ONLY] Email failed, but proceeding since we are in dev mode. Error: ${emailResult.error}`);
      }
    }

    res.json({ success: true, message: 'Code sent to email' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Reset Password — Verify Code + Update Hash ────────────────────────────────
app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
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
app.get('/api/admin/export-users', requireAdmin, async (req, res) => {
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
  console.log(`[LEAD] Incoming lead capture`);
  if (!name || !email || !mobile) return res.status(400).json({ error: 'Missing lead info' });

  // Input validation
  if (!validator.isEmail(String(email))) return res.status(400).json({ error: 'Invalid email' });
  const safeName = validator.escape(String(name).trim().slice(0, 100));
  const safeMobile = validator.escape(String(mobile).trim().slice(0, 15));

  try {
    const { error: upsertError } = await supabase
      .from('leads')
      .upsert({ 
        name: safeName, 
        email: email.trim(), 
        mobile: safeMobile, 
        joined_at: joinedAt || new Date().toISOString() 
      }, { onConflict: 'email' });
    
    if (upsertError) throw upsertError;
    
    setTimeout(syncLeadsToExcel, 300);

    // Auto-register/login user
    let { data: user, error: searchError } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.trim())
      .maybeSingle();

    if (searchError) throw searchError;

    if (!user) {
      const { data: newUser, error: createError } = await supabase
        .from('users')
        .insert({ 
          name: safeName,
          email: email.trim(),
          mobile_number: safeMobile, 
          auth_provider: 'lead', 
          is_mobile_verified: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .select()
        .single();
      
      if (createError) throw createError;
      user = newUser;
    }

    await issueToken(res, user.id, !user.business_stage, user.email, user.name, null);
  } catch (err) {
    console.error('[LEAD] Error:', err.message);
    res.status(500).json({ error: 'Lead save failed' });
  }
});

// ── Download Leads as Excel ───────────────────────────────────────────────────
app.get('/api/admin/export-leads', requireAdmin, async (req, res) => {
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

app.post('/api/documents/sync', requireAdmin, (req, res) => {
  console.log('[API] Admin authorized manual synchronization sweep across all Founder Documents.');
  manuallySyncAllDocuments();
  res.json({ success: true, message: 'Sync queued successfully' });
});

// --- AI Blueprint Generator ---

app.post('/api/generate-blueprint', requireAuth, planCheckMiddleware, aiLimiter, async (req, res) => {
  const { skills, niches, budget } = req.body;
  
  if (!skills || !niches || !budget) {
    return res.status(400).json({ error: 'Skills, Niches, and Budget are required to build a blueprint.' });
  }

  const systemPrompt = `You are "Launchpad Bharat AI" — India's most brutally honest Startup Architect, built specifically for first-time founders in Tier-2 and Tier-3 Indian cities.

Your personality: You think like a seasoned Indian VC but speak in very simple, easy-to-understand language. You are direct, specific, and brutally practical. You NEVER give generic advice. 

CORE RULES YOU NEVER BREAK:
1. ZERO paid tools unless absolutely unavoidable — always suggest free alternatives first.
2. NO domain cost — use Vercel free subdomain or Carrd free tier.
3. NO ad spend — use organic distribution like Instagram Reels, YouTube Shorts, WhatsApp Status, local outreach.
4. NO paid hosting — Vercel, Railway, Render, Supabase free tiers.
5. NO paid email — use Gmail + Brevo free tier.
6. EVERY startup idea must be 100% UNIQUE. Never repeat ideas. Blend the user's specific skill and niche into a wildly creative, highly profitable business model that nobody is talking about yet.
7. ALL content must be DENSE, DETAILED, and ACTIONABLE. Do not give 1-sentence answers. Provide deep context, exact steps, and heavy detail (100-200 words per section) while keeping the language extremely simple.
8. EVERY idea must have a WhatsApp-first or offline-first distribution strategy.
9. EVERY startup name must be catchy, short, and available.
10. Treat the founder's skill as the core competitive moat.
11. GST and legal compliance must be mentioned honestly.
12. Be a mentor, flag real risks, and give complete, dense data.

BUDGET LOGIC:
- Under 5000 INR: Pure service/consulting model, zero product build
- 5000-15000 INR: No-code MVP only (Glide, Softr, Carrd, WhatsApp Business)
- 15000-50000 INR: Lightweight web app (Next.js on Vercel + Supabase)
- 50000-200000 INR: Full MVP with basic automation
- Above 200000 INR: Product + small team + first paid marketing

OUTPUT FORMAT: Respond ONLY with a valid JSON object. No markdown. No explanation outside JSON. Every value must be exactly the type shown in the schema.`;

  const userPrompt = `Generate a highly detailed, extremely dense "Launchpad Bharat Blueprint" for this founder. The content must be written in easily-digestible, simple English but contain professional-grade detail.

FOUNDER PROFILE:
- Skills: ${skills}
- Target Industry/Niche: ${niches}
- Total Starting Budget: INR ${budget} (HARD LIMIT)

YOUR TASK:
Generate a completely unique startup idea. Explain exactly what the product is, how it works, and how to sell it. Don't be brief — write dense paragraphs (3-5 sentences) for the problem, solution, and adaptations.

Respond ONLY with this exact JSON structure:

{
  "startup_name": "string — Catchy name",
  "tagline": "string — Punchy one liner",
  "foreign_inspiration": {
    "company": "string — Exact foreign company name",
    "country": "string — Country",
    "why_not_in_india_yet": "string — Detailed reason"
  },
  "problem_statement": "string — Dense 4-5 sentences. Real scenarios of the pain point.",
  "solution": "string — Dense 4-5 sentences. Exact step-by-step of how the product works.",
  "indian_adaptation": {
    "distribution": "string — Step-by-step WhatsApp/Offline strategy",
    "trust_building": "string — Dense trust building tactics",
    "language": "string — Detailed regional language strategy",
    "payment": "string — Exact pricing and payment collection model"
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

    // ── Record blueprint generation for live stats ─────────────────────────────
    const { userName, userEmail, skills, niches, budget, userId } = req.body;
    if (supabase) {
      const payload = {
        name: userName || 'Founder',
        email: userEmail || 'N/A',
        skills: skills || 'N/A',
        niches: niches || 'N/A',
        budget: budget || '0',
        startup_name: blueprintData.startup_name || 'New Stealth Startup',
        created_at: new Date().toISOString(),
        timestamp: new Date().toISOString(), // Supporting legacy & new columns
        time_stamp: new Date().toISOString()
      };
      
      if (userId) payload.user_id = userId;

      const { error: bpErr } = await supabase.from('blueprints_generated').insert([payload]);
      if (bpErr) {
        console.error('[DB] blueprints_generated insert failure:', bpErr);
      } else {
        console.log('[DB] Blueprint successfully recorded for:', userName);
      }

      // Enrich main leads table with discovered skills/niches
      if (userEmail && userEmail !== 'N/A') {
        const { error: ldErr } = await supabase.from('leads').upsert({
          name: userName || 'Founder',
          email: userEmail,
          skills: skills || null,
          industry: niches || null,
          joined_at: new Date().toISOString()
        }, { onConflict: 'email' });
        if (ldErr) console.error('[DB] leads upsert error:', ldErr.message);
      }

      // Increment blueprint count for the user
      if (req.userPlan) {
        const { error: incErr } = await supabase
          .from('user_plans')
          .update({ blueprint_count_this_month: req.userPlan.blueprint_count_this_month + 1 })
          .eq('user_id', req.userId);
        if (incErr) {
          console.error('[DB] Failed to increment blueprint count:', incErr.message);
        } else {
          console.log('[DB] Blueprint count incremented for user:', req.userId);
        }
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
    if (!supabase) return res.status(503).json({ error: 'DB not connected' });

    // 1. Count Founders from Leads table
    const { count: leadsCount, error: leadsErr } = await supabase
      .from('leads')
      .select('*', { count: 'exact', head: true });
    
    // 2. Count Blueprints from dedicated blueprints_generated table
    const { count: bpCount, error: bpErr } = await supabase
      .from('blueprints_generated')
      .select('*', { count: 'exact', head: true });

    // 3. Count dynamic resources
    const { count: docsCount, error: docsErr } = await supabase
      .from('documents')
      .select('*', { count: 'exact', head: true });

    // 4. Fetch latest activities for the labels
    const { data: latestLeads } = await supabase
      .from('leads')
      .select('name')
      .order('joined_at', { ascending: false })
      .limit(1);

    const { data: latestBps } = await supabase
      .from('blueprints_generated')
      .select('name, startup_name')
      .order('created_at', { ascending: false })
      .limit(1);

    if (leadsErr || bpErr || docsErr) throw (leadsErr || bpErr || docsErr);

    const realFounders = leadsCount || 0;
    const realBlueprints = bpCount || 0;
    
    // Adjusted offsets (Base counts + real data)
    const blueprintsGenerated = 54 + realBlueprints; 
    const foundersJoined = 91 + realFounders;
    const resourcesAdded = 110 + (docsCount || 0);

    const latestFounder = (latestLeads && latestLeads.length > 0) 
      ? latestLeads[0].name 
      : "Be the first to join →";

    const latestBlueprintUser = (latestBps && latestBps.length > 0) 
      ? `${latestBps[0].name} built ${latestBps[0].startup_name}`
      : "Latest: AI Startup Blueprint";

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

// ── Live Join Recording: Save new visitors to Supabase ──────────────────────
app.post('/api/stats/join', async (req, res) => {
  try {
    const { name, email, mobile, skills, domain } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    if (!supabase) {
      console.warn('⚠️ Supabase not connected. Skipping recording of join:', name);
      return res.status(200).json({ success: true, message: 'Simulated join (DB disconnected)' });
    }

    // ── Upsert into Leads table as the primary source of truth ────────────────
    const { error } = await supabase
      .from('leads')
      .upsert({ 
        name: name.trim(),
        email: email ? email.trim() : `guest_${Date.now()}@launchpadbharat.com`, 
        mobile: mobile ? mobile.trim() : null,
        skills: skills || null,
        industry: domain || null,
        joined_at: new Date().toISOString() 
      }, { onConflict: 'email' });

    if (error) {
      console.error('[API] Error saving join to Supabase:', error.message);
      return res.status(500).json({ error: 'Database record failed' });
    }

    console.log(`✨ New founder joined: ${name}`);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('[API] Join recording error:', err.message);
    res.status(500).json({ error: 'Server error during join' });
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

app.post('/api/reviews', reviewLimiter, async (req, res) => {
  try {
    const { name, age, location, description } = req.body;
    if (!name || !description) return res.status(400).json({ error: 'Name and description are required' });

    // Input validation & sanitization
    const safeName = validator.escape(String(name).trim().slice(0, 100));
    const safeDescription = validator.escape(String(description).trim().slice(0, 1000));
    const safeLocation = location ? validator.escape(String(location).trim().slice(0, 100)) : null;

    const { error } = await supabase
      .from('reviews')
      .insert({ name: safeName, age, location: safeLocation, description: safeDescription });
    
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

// ── AI Architect Chat Endpoint ──────────────────────────────────────────────
app.post('/api/chat-architect', requireAuth, chatLimitMiddleware, async (req, res) => {
  const { message, history, blueprint } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message is required.' });
  }

  const systemPrompt = `You are "AI Architect" — the co-founder and mentor for this startup from Launchpad Bharat.
Your goal is to guide the founder through executing their blueprint: "${blueprint?.startup_name || 'their startup'}".
You are brutally honest, practical, Indian-focused, and frugal (always suggest free tools first, no paid ads).
Speak in simple, clear, conversational English. Never give generic business school advice. Give exact step-by-step local execution steps.

Here is the blueprint they generated:
${JSON.stringify(blueprint, null, 2)}

Answer their question directly and concisely. Do not wrap in JSON. Just return plain text.`;

  const userPrompt = `Chat History:
${(history || []).map(h => `${h.role === 'user' ? 'Founder' : 'AI Architect'}: ${h.content}`).join('\n')}
Founder: ${message}
AI Architect:`;

  try {
    const aiResponse = await callAIWithFallback(systemPrompt, userPrompt, false);
    res.json({ response: aiResponse });
  } catch (err) {
    console.error('[CHAT-ARCHITECT] Error:', err.message);
    res.status(500).json({ error: 'Failed to process message. Please try again.' });
  }
});

// ── Get User Plan & Limits ───────────────────────────────────────────────────
app.get('/api/user/plan', requireAuth, async (req, res) => {
  try {
    let { data: plan, error } = await supabase
      .from('user_plans')
      .select('*')
      .eq('user_id', req.userId)
      .maybeSingle();

    if (!plan || (error && error.code === 'PGRST116')) {
      const { data: newPlan, error: insertError } = await supabase
        .from('user_plans')
        .insert({ user_id: req.userId, plan: 'free', blueprint_count_this_month: 0 })
        .select()
        .single();
      if (insertError) throw insertError;
      plan = newPlan;
    } else if (error) {
      throw error;
    }

    res.json({
      plan: plan.plan,
      blueprint_count_this_month: plan.blueprint_count_this_month,
      chat_message_count_this_session: plan.chat_message_count_this_session
    });
  } catch (err) {
    console.error('[GET-PLAN] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch plan' });
  }
});

// ── Razorpay Payment & Upgrade ───────────────────────────────────────────────
app.post('/api/user/upgrade', requireAuth, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  try {
    // In development/test mode: skip real verification
    if (process.env.NODE_ENV !== 'production') {
      const { error } = await supabase
        .from('user_plans')
        .update({ plan: 'premium', upgraded_at: new Date().toISOString() })
        .eq('user_id', req.userId);
      
      if (error) throw error;
      return res.json({ success: true, plan: 'premium', mode: 'test' });
    }

    // Production: verify Razorpay HMAC-SHA256 signature
    const RAZORPAY_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!RAZORPAY_SECRET) {
      console.error('[UPGRADE] Missing RAZORPAY_WEBHOOK_SECRET in production');
      return res.status(500).json({ error: 'RAZORPAY_CONFIG_MISSING' });
    }

    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', RAZORPAY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'INVALID_PAYMENT_SIGNATURE' });
    }

    const { error } = await supabase
      .from('user_plans')
      .update({ plan: 'premium', upgraded_at: new Date().toISOString() })
      .eq('user_id', req.userId);

    if (error) throw error;

    return res.json({ success: true, plan: 'premium' });
  } catch (err) {
    console.error('[UPGRADE] Error:', err.message);
    res.status(500).json({ error: 'Upgrade failed' });
  }
});

// ── Testimonials Section (GET approved, POST submit) ─────────────────────────
app.get('/api/testimonials', async (req, res) => {
  try {
    const { data: list, error } = await supabase
      .from('testimonials')
      .select('id, quote, startup_name, submitted_at, users(name, profile_picture)')
      .eq('approved', true)
      .order('submitted_at', { ascending: false });

    if (error) throw error;
    res.json(list || []);
  } catch (err) {
    console.error('[GET-TESTIMONIALS] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch testimonials' });
  }
});

app.post('/api/testimonials', requireAuth, async (req, res) => {
  const { quote, startup_name } = req.body;

  if (!quote?.trim()) {
    return res.status(400).json({ error: 'Quote is required.' });
  }

  const safeQuote = validator.escape(String(quote).trim().slice(0, 1000));
  const safeStartupName = startup_name ? validator.escape(String(startup_name).trim().slice(0, 100)) : null;

  try {
    const { error } = await supabase
      .from('testimonials')
      .insert({
        user_id: req.userId,
        quote: safeQuote,
        startup_name: safeStartupName,
        approved: false // requires admin approval
      });

    if (error) {
      // Check if trigger limit error
      if (error.message && error.message.includes('Testimonial limit reached')) {
        return res.status(429).json({ error: 'LIMIT_REACHED', message: 'You can submit at most 3 testimonials.' });
      }
      throw error;
    }

    res.json({ success: true, message: 'Testimonial submitted successfully. Pending approval.' });
  } catch (err) {
    console.error('[POST-TESTIMONIAL] Error:', err.message);
    res.status(500).json({ error: 'Failed to submit testimonial' });
  }
});

// ── Post-Generation Outcomes Survey (30-day feedback) ───────────────────────
app.post('/api/blueprint/outcome', requireAuth, async (req, res) => {
  const { blueprint_id, outcome, rating } = req.body;

  if (!blueprint_id) {
    return res.status(400).json({ error: 'Blueprint ID is required.' });
  }

  try {
    const { error } = await supabase
      .from('blueprint_outcomes')
      .insert({
        user_id: req.userId,
        blueprint_id,
        outcome: outcome ? validator.escape(String(outcome).trim()) : null,
        rating: rating ? parseInt(rating, 10) : null
      });

    if (error) throw error;
    res.json({ success: true, message: 'Outcome recorded' });
  } catch (err) {
    console.error('[BLUEPRINT-OUTCOME] Error:', err.message);
    res.status(500).json({ error: 'Failed to record outcome' });
  }
});

// ── Save Calculator Inputs & Outputs ─────────────────────────────────────────
app.post('/api/user/save-calculator', requireAuth, async (req, res) => {
  const { calculator_type, input_params, result_data } = req.body;

  if (!calculator_type || !input_params || !result_data) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  try {
    const { error } = await supabase
      .from('calculator_results')
      .insert({
        user_id: req.userId,
        calculator_type,
        input_params,
        result_data
      });

    if (error) throw error;
    res.json({ success: true, message: 'Calculator result saved' });
  } catch (err) {
    console.error('[SAVE-CALCULATOR] Error:', err.message);
    res.status(500).json({ error: 'Failed to save calculator results' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('auth_token', {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: IS_PRODUCTION ? 'none' : 'lax'
  });
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
