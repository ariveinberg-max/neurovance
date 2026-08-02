import nodemailer from 'nodemailer';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = join(__dirname, '..', 'public', 'brand', 'neurovance-lockup.png');

// Free, real email sending via the account owner's own Gmail using an
// "app password" (never their real password) — no paid service needed.
// Falls back to printing the code to the server console if credentials
// aren't set yet, so the signup flow stays testable while waiting on them.
let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const { GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return null;
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  return transporter;
}

export async function sendVerificationCode(toEmail, code) {
  const t = getTransporter();
  if (!t) {
    console.log(`[mailer] GMAIL_USER/GMAIL_APP_PASSWORD not set — verification code for ${toEmail}: ${code}`);
    return;
  }
  await t.sendMail({
    from: process.env.GMAIL_USER,
    to: toEmail,
    subject: 'Your verification code',
    text: `Your verification code is ${code}. It expires in 10 minutes.`,
    html: `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#08090a; padding:40px 0;">
        <tr><td align="center">
          <table role="presentation" width="420" cellpadding="0" cellspacing="0" style="background:#000000; border:1px solid #1c1d21;">
            <tr><td align="center" style="padding:40px 24px 8px;">
              <img src="cid:neurovance-logo" width="260" alt="Neurovance" style="display:block; max-width:260px;" />
            </td></tr>
            <tr><td align="center" style="padding:0 24px 32px; font-family:-apple-system,Helvetica,Arial,sans-serif;">
              <div style="font-size:12px; letter-spacing:0.5px; color:#6b6c74;">Your Superself is almost ready.</div>
            </td></tr>
            <tr><td align="center" style="padding:0 32px 40px; font-family:-apple-system,Helvetica,Arial,sans-serif;">
              <div style="font-size:11px; letter-spacing:2px; color:#6b6c74; text-transform:uppercase; margin-bottom:18px;">Verification code</div>
              <div style="font-size:36px; letter-spacing:8px; color:#f2f3f5; font-weight:600;">${code}</div>
              <div style="font-size:12px; color:#4a4b50; margin-top:20px;">Expires in 10 minutes.</div>
            </td></tr>
          </table>
        </td></tr>
      </table>
    `,
    attachments: [
      { filename: 'neurovance-lockup.png', path: LOGO_PATH, cid: 'neurovance-logo' },
    ],
  });
}
