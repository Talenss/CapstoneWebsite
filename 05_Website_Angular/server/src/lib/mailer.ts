/* Linaw PH — lib/mailer.ts
   One job: deliver the 6-digit codes for email verification and password
   reset. Works with any SMTP provider (Gmail app password, Brevo, …); see
   SETUP.md. When SMTP isn't configured, callers can still let development
   proceed by surfacing the code another way (see routes/auth.ts). */
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM, BREVO_API_KEY } from '../config';

export type CodePurpose = 'verify' | 'reset';

/** A small text attachment — used for the interview .ics calendar file. */
export interface MailAttachment {
  filename: string;
  content: string;
  contentType?: string;
}

export function mailConfigured(): boolean {
  return !!(MAIL_FROM && (BREVO_API_KEY || SMTP_HOST));
}

/** Which way mail leaves this process. */
export function mailTransport(): 'https' | 'smtp' | 'none' {
  if (!MAIL_FROM) return 'none';
  if (BREVO_API_KEY) return 'https';
  return SMTP_HOST ? 'smtp' : 'none';
}

/** Split "Linaw PH <team@example.com>" into its parts. Brevo wants the
 *  name and the address as separate fields; SMTP takes the whole string. */
function parseAddress(v: string): { name?: string; email: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(v);
  return m ? { name: m[1] || undefined, email: m[2].trim() } : { email: v.trim() };
}

/** Post one message to Brevo's REST API.
 *
 *  Same message, same branded HTML, different pipe — chosen because Render's
 *  free instances cannot reach an SMTP port at all, while HTTPS is open. */
async function sendViaHttps(
  to: string, subject: string, text: string, html: string, replyTo?: string,
  attachment?: MailAttachment,
): Promise<void> {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: parseAddress(MAIL_FROM),
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
      ...(replyTo ? { replyTo: { email: replyTo } } : {}),
      // Brevo takes attachments as base64 content plus a filename.
      ...(attachment ? { attachment: [{ name: attachment.filename, content: Buffer.from(attachment.content, 'utf8').toString('base64') }] } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`Brevo send failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
}

let transport: Transporter | null = null;
function getTransport(): Transporter {
  if (!transport) {
    /* POOLED, and that is a latency decision rather than a tidiness one.
       Without a pool nodemailer opens a fresh connection for every message:
       TCP, STARTTLS, a TLS handshake and an AUTH round trip before a single
       byte of the mail moves. Against Gmail from a server in another region
       that is seconds, and the caller waits for all of it, because the
       verification code cannot honestly be reported as sent until it is.
       A pooled transport keeps the authenticated connection open, so only
       the first message after an idle period pays that cost. */
    transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      connectionTimeout: 15000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  }
  return transport;
}

const COPY: Record<CodePurpose, { subject: string; heading: string; line: string }> = {
  verify: {
    subject: 'Your Linaw PH verification code',
    heading: 'Confirm your email address',
    line: 'Use this code to finish creating your Linaw PH account. It expires in 10 minutes.',
  },
  reset: {
    subject: 'Your Linaw PH password reset code',
    heading: 'Reset your password',
    line: 'Use this code to set a new password for your Linaw PH account. It expires in 10 minutes. If you didn’t ask for this, you can safely ignore this email. Your password is unchanged.',
  },
};

/** The shared branded wrapper every Linaw PH email uses. */
function shell(bodyHtml: string): string {
  return `
<div style="margin:0;padding:28px 16px;background:#F3EEE3;font-family:Georgia,'Times New Roman',serif;color:#1E2430">
  <div style="max-width:480px;margin:0 auto;background:#FFFFFF;border:1px solid #E3DCCB;border-radius:12px;overflow:hidden">
    <div style="background:#141926;color:#FFFFFF;padding:18px 26px;font-size:17px">
      <b>Linaw</b><span style="color:#C9A24B"> PH</span>
    </div>
    <div style="padding:28px 26px">${bodyHtml}</div>
    <div style="padding:14px 26px;border-top:1px solid #EEE8DA;font-size:11.5px;color:#8A8FA0">
      Linaw PH · an academic capstone project of the School of Computing, Holy Angel University
    </div>
  </div>
</div>`;
}

/** Generic branded email. `bodyHtml` goes inside the shell; `text` is the
 *  plain-text alternative. */
export async function sendMail(to: string, subject: string, text: string, bodyHtml: string, opts?: { replyTo?: string; attachment?: MailAttachment }): Promise<void> {
  const body = `${text}\n\n— Linaw PH · an academic capstone project, Holy Angel University`;
  const html = shell(bodyHtml);

  if (mailTransport() === 'https') {
    await sendViaHttps(to, subject, body, html, opts?.replyTo, opts?.attachment);
    return;
  }
  await getTransport().sendMail({
    from: MAIL_FROM, to, replyTo: opts?.replyTo, subject, text: body, html,
    ...(opts?.attachment
      ? { attachments: [{ filename: opts.attachment.filename, content: opts.attachment.content, contentType: opts.attachment.contentType || 'text/calendar; method=REQUEST' }] }
      : {}),
  });
}

export async function sendCodeEmail(to: string, code: string, purpose: CodePurpose): Promise<void> {
  const c = COPY[purpose];
  const digits = code
    .split('')
    .map((d) => `<span style="display:inline-block;min-width:26px;padding:10px 6px;margin:0 3px;border:1px solid #D8CFBE;border-radius:8px;background:#FAF6EE;font-size:26px;font-weight:700;letter-spacing:0">${d}</span>`)
    .join('');
  await sendMail(
    to,
    c.subject,
    `${c.heading}\n\n${c.line}\n\nYour code: ${code}`,
    `
      <h1 style="margin:0 0 10px;font-size:22px">${c.heading}</h1>
      <p style="margin:0 0 22px;font-size:14.5px;line-height:1.65;color:#4C5566">${c.line}</p>
      <div style="text-align:center;margin:0 0 22px">${digits}</div>
      <p style="margin:0;font-size:12.5px;line-height:1.6;color:#8A8FA0">
        Never share this code with anyone. Linaw PH staff will never ask for it.
        If you didn’t request it, no action is needed.
      </p>`,
  );
}
