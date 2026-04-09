/**
 * SMS SERVICE MODULE - Launchpad Bharat
 * 
 * Provider: Vonage (formerly Nexmo) — 100% FREE to start
 * ─────────────────────────────────────────────────────
 * SETUP (5 minutes, zero payment):
 *  1. Go to: https://dashboard.nexmo.com/sign-up
 *  2. Sign up with your email (no credit card needed)
 *  3. Get your API Key + API Secret from the dashboard
 *  4. Paste both into .env as VONAGE_API_KEY and VONAGE_API_SECRET
 *  5. You receive €2 free credit (~100+ OTPs to Indian numbers)
 * 
 * AUTOMATIC DEV MODE:
 *  If keys are missing or SMS_DEV_MODE=true, OTP prints to terminal.
 */

import https from 'https';
import querystring from 'querystring';

export const sendOtpSms = async (mobileNumber, otp) => {
  const apiKey    = process.env.VONAGE_API_KEY;
  const apiSecret = process.env.VONAGE_API_SECRET;
  const isDevMode = process.env.SMS_DEV_MODE === 'true' 
    || !apiKey || apiKey === 'YOUR_VONAGE_API_KEY'
    || !apiSecret || apiSecret === 'YOUR_VONAGE_API_SECRET';

  // ── STEP 1: Log generation ────────────────────────────────────────────────
  console.log('\n[SMS PIPELINE] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`[SMS PIPELINE] Target Number : ${mobileNumber}`);
  console.log(`[SMS PIPELINE] OTP Generated : ${otp}`);
  console.log(`[SMS PIPELINE] Expiry        : 5 minutes`);

  // ── STEP 2: DEV MODE ─────────────────────────────────────────────────────
  if (isDevMode) {
    console.log('[SMS PIPELINE] Mode          : DEV (terminal only)');
    console.log('[SMS PIPELINE] ┌──────────────────────────────────────────┐');
    console.log(`[SMS PIPELINE] │  📱 OTP for ${mobileNumber} : ${otp}  │`);
    console.log('[SMS PIPELINE] └──────────────────────────────────────────┘');
    console.log('[SMS PIPELINE] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    return { success: true, provider: 'DEV_MODE' };
  }

  // ── STEP 3: PRODUCTION via Vonage REST API ────────────────────────────────
  console.log('[SMS PIPELINE] Mode          : PRODUCTION (Vonage)');

  const smsMessage = `${otp} is your Launchpad Bharat verification code. Valid for 5 minutes.`;

  const postData = querystring.stringify({
    api_key:    apiKey,
    api_secret: apiSecret,
    to:         mobileNumber.replace('+', ''),  // Vonage needs E.164 without '+'
    from:       'LaunchpadIN',
    text:       smsMessage
  });

  console.log('[SMS PIPELINE] Calling Vonage API...');
  console.log('[SMS PIPELINE] To:', mobileNumber, '| From: LaunchpadIN');

  return new Promise((resolve) => {
    const options = {
      hostname: 'rest.nexmo.com',
      path:     '/sms/json',
      method:   'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let rawData = '';
      res.on('data',  (chunk) => { rawData += chunk; });
      res.on('end', () => {
        try {
          const parsed   = JSON.parse(rawData);
          const msgStatus = parsed.messages?.[0];

          console.log('[SMS PIPELINE] HTTP Status  :', res.statusCode);
          console.log('[SMS PIPELINE] API Response :', JSON.stringify(parsed));

          if (msgStatus?.status === '0') {
            console.log('[SMS PIPELINE] ✅ SUCCESS — OTP delivered. Message ID:', msgStatus['message-id']);
            console.log('[SMS PIPELINE] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
            resolve({ success: true, provider: 'VONAGE', messageId: msgStatus['message-id'] });
          } else {
            const errText = msgStatus?.['error-text'] || 'Vonage rejected the request';
            console.error('[SMS PIPELINE] ❌ FAILED. Status:', msgStatus?.status, '| Error:', errText);
            console.log('[SMS PIPELINE] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
            resolve({ success: false, error: errText });
          }
        } catch (e) {
          console.error('[SMS PIPELINE] ❌ Failed to parse Vonage response:', rawData);
          resolve({ success: false, error: 'Invalid response from Vonage' });
        }
      });
    });

    req.on('error', (e) => {
      console.error('[SMS PIPELINE] ❌ Network error reaching Vonage:', e.message);
      console.log('[SMS PIPELINE] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      resolve({ success: false, error: 'Network error: Could not reach Vonage API' });
    });

    req.write(postData);
    req.end();
  });
};
