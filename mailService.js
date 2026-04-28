import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

// Create the transporter using environment variables
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_PORT === '465', // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Verify connection configuration on startup
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter.verify((error, success) => {
    if (error) {
      console.error('[SMTP] Connection Error:', error.message);
    } else {
      console.log('[SMTP] Server is ready to take our messages');
    }
  });
} else {
  console.warn('[SMTP] Missing SMTP credentials in .env. Email delivery will fail.');
}

/**
 * Sends a password reset email with the 6-digit code.
 * @param {string} toEmail - The recipient's email address.
 * @param {string} code - The 6-digit reset code.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export const sendResetEmail = async (toEmail, code) => {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.error('[SMTP] Cannot send email. Missing SMTP credentials.');
    return { success: false, error: 'SMTP not configured' };
  }

  const fromEmail = process.env.SMTP_FROM || `"Launchpad Bharat" <noreply@launchpadbharat.com>`;

  const mailOptions = {
    from: fromEmail,
    to: toEmail,
    subject: 'Password Reset Code - Launchpad Bharat',
    text: `Your password reset code is: ${code}\nThis code will expire in 15 minutes.`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
        <h2 style="color: #2D3748; text-align: center;">Launchpad Bharat</h2>
        <p style="font-size: 16px; color: #4A5568;">Hello,</p>
        <p style="font-size: 16px; color: #4A5568;">You requested a password reset. Your 6-digit code is:</p>
        <div style="text-align: center; margin: 30px 0;">
          <span style="font-size: 32px; font-weight: bold; background-color: #EDF2F7; padding: 10px 20px; border-radius: 8px; letter-spacing: 4px; color: #2B6CB0;">
            ${code}
          </span>
        </div>
        <p style="font-size: 14px; color: #718096; text-align: center;">This code will expire in 15 minutes.</p>
        <p style="font-size: 14px; color: #718096; text-align: center;">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`[SMTP] Reset email sent to ${toEmail}. Message ID: ${info.messageId}`);
    return { success: true };
  } catch (error) {
    console.error(`[SMTP] Failed to send email to ${toEmail}:`, error.message);
    return { success: false, error: error.message };
  }
};
