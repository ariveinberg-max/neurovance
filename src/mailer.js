import nodemailer from 'nodemailer';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dns from 'dns';

// Render's free-tier containers have no outbound IPv6 route. Passing
// family:4 to nodemailer wasn't enough to stop it picking an AAAA record —
// this custom lookup forces every DNS resolution during the SMTP connection
// to only ever return an IPv4 address, so there's no path to IPv6 at all.
function lookupIPv4(hostname, options, callback) {
  dns.lookup(hostname, { family: 4 }, callback);
}

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
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    lookup: lookupIPv4,
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
    from: process.env.GMAIL_SEND_AS || `"Neurovance" <${process.env.GMAIL_USER}>`,
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

// Sends one announcement email to one recipient, styled like the rest of
// Neurovance's mail. Callers send one-at-a-time (never a shared To/Cc list)
// so waitlist emails are never exposed to each other, and pace calls with a
// delay to stay well under Gmail's sending limits for a personal account.
export async function sendBroadcast(toEmail, subject, bodyHtml, bodyText) {
  const t = getTransporter();
  if (!t) {
    console.log(`[mailer] GMAIL_USER/GMAIL_APP_PASSWORD not set — broadcast to ${toEmail}: ${subject}`);
    return;
  }
  await t.sendMail({
    from: process.env.GMAIL_SEND_AS || `"Neurovance" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject,
    text: bodyText,
    html: `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#08090a; padding:40px 0;">
        <tr><td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#000000; border:1px solid #1c1d21;">
            <tr><td align="center" style="padding:40px 24px 8px;">
              <img src="cid:neurovance-logo" width="220" alt="Neurovance" style="display:block; max-width:220px;" />
            </td></tr>
            <tr><td style="padding:24px 36px 40px; font-family:-apple-system,Helvetica,Arial,sans-serif; font-size:14px; line-height:1.7; color:#c9cad0;">
              ${bodyHtml}
            </td></tr>
            <tr><td align="center" style="padding:0 24px 32px; font-family:-apple-system,Helvetica,Arial,sans-serif; font-size:11px; color:#4a4b50;">
              You're getting this because you joined the Neurovance waitlist. Reply and let us know if you'd rather not hear from us again.
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

// A user's feedback, straight to Ari's own inbox — no dashboard to
// remember to check, no queue that quietly fills up unread. Also saved to
// Firestore (see server.js) so there's a durable record even if an email
// gets missed.
export async function sendFeedbackNotification(user, message) {
  const t = getTransporter();
  if (!t) {
    console.log(`[mailer] GMAIL_USER/GMAIL_APP_PASSWORD not set — feedback from ${user.username}: ${message}`);
    return;
  }
  await t.sendMail({
    from: process.env.GMAIL_SEND_AS || `"Neurovance" <${process.env.GMAIL_USER}>`,
    to: process.env.GMAIL_USER,
    subject: `Feedback from ${user.username}`,
    text: `${user.username} (${user.email || 'no email on file'}):\n\n${message}`,
    html: `<p><strong>${user.username}</strong> (${user.email || 'no email on file'}):</p><p>${message.replace(/\n/g, '<br>')}</p>`,
  });
}

export async function sendWaitlistNotification(email) {
  const t = getTransporter();
  if (!t) {
    console.log(`[mailer] GMAIL_USER/GMAIL_APP_PASSWORD not set — new waitlist signup: ${email}`);
    return;
  }
  await t.sendMail({
    from: process.env.GMAIL_SEND_AS || `"Neurovance" <${process.env.GMAIL_USER}>`,
    to: process.env.GMAIL_USER,
    subject: 'New waitlist signup',
    text: `${email} joined the Neurovance waitlist.`,
    html: `<p><strong>${email}</strong> joined the Neurovance waitlist.</p>`,
  });
}
