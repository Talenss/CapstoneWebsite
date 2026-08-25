/* ResumeMatch PH — tests/mailer-https.test.ts

   Render's free instances block outbound SMTP entirely, so the mailer can
   post to Brevo's REST API over HTTPS instead. These pin the request that
   goes out, because the alternative way to learn it is wrong is a
   participant never receiving a verification code. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

function load(env: Record<string, string>) {
  /* Set to empty rather than delete. config.ts calls dotenv.config(), which
     fills in any key that is ABSENT from process.env — so deleting these
     would let a developer's real .env decide the outcome, and the test would
     pass or fail depending on whose machine it ran on. An empty string is
     present, so dotenv leaves it alone. */
  for (const k of ['BREVO_API_KEY', 'SMTP_HOST', 'MAIL_FROM', 'SMTP_USER', 'SMTP_PASS']) process.env[k] = '';
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/lib/mailer')];
  return require('../src/lib/mailer') as typeof import('../src/lib/mailer');
}

const FROM = 'ResumeMatch PH <team@resumematch.ph>';
const realFetch = globalThis.fetch;

test('HTTPS is chosen when a key is present, SMTP otherwise', () => {
  assert.equal(load({ BREVO_API_KEY: 'k', MAIL_FROM: FROM }).mailTransport(), 'https');
  assert.equal(load({ SMTP_HOST: 'smtp.gmail.com', MAIL_FROM: FROM }).mailTransport(), 'smtp');
  assert.equal(load({ MAIL_FROM: FROM }).mailTransport(), 'none');
  // a key with no MAIL_FROM cannot address a message
  assert.equal(load({ BREVO_API_KEY: 'k' }).mailTransport(), 'none');
});

test('the key takes precedence over SMTP, since SMTP may be unreachable', () => {
  const m = load({ BREVO_API_KEY: 'k', SMTP_HOST: 'smtp.gmail.com', MAIL_FROM: FROM });
  assert.equal(m.mailTransport(), 'https');
});

test('mailConfigured is true for either transport', () => {
  assert.equal(load({ BREVO_API_KEY: 'k', MAIL_FROM: FROM }).mailConfigured(), true);
  assert.equal(load({ SMTP_HOST: 'h', MAIL_FROM: FROM }).mailConfigured(), true);
  assert.equal(load({ MAIL_FROM: FROM }).mailConfigured(), false);
});

test('the outgoing request carries the key, the split sender, and both bodies', async () => {
  const m = load({ BREVO_API_KEY: 'secret-key', MAIL_FROM: FROM });
  let seen: any = null;
  globalThis.fetch = (async (url: any, init: any) => {
    seen = { url: String(url), init };
    return new Response('{"messageId":"x"}', { status: 201 });
  }) as any;
  try {
    await m.sendMail('applicant@example.com', 'Subject line', 'plain body', '<p>rich body</p>',
                     { replyTo: 'recruiter@example.com' });
  } finally { globalThis.fetch = realFetch; }

  assert.equal(seen.url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['api-key'], 'secret-key');
  const b = JSON.parse(seen.init.body);
  assert.deepEqual(b.sender, { name: 'ResumeMatch PH', email: 'team@resumematch.ph' },
    'the display name and address must be separate fields, not one string');
  assert.deepEqual(b.to, [{ email: 'applicant@example.com' }]);
  assert.equal(b.subject, 'Subject line');
  assert.match(b.textContent, /plain body/);
  assert.match(b.htmlContent, /rich body/);
  assert.match(b.htmlContent, /ResumeMatch/, 'the branded shell must still wrap the body');
  assert.deepEqual(b.replyTo, { email: 'recruiter@example.com' },
    'reply-to is what lets an applicant answer the recruiter directly');
});

test('a rejected send throws, so the route can withdraw the code', async () => {
  const m = load({ BREVO_API_KEY: 'bad', MAIL_FROM: FROM });
  globalThis.fetch = (async () => new Response('{"message":"unauthorized"}', { status: 401 })) as any;
  try {
    await assert.rejects(
      () => m.sendMail('a@b.com', 's', 't', '<p>h</p>'),
      /Brevo send failed \(401\)/,
    );
  } finally { globalThis.fetch = realFetch; }
});

test('a bare address with no display name is still valid', async () => {
  const m = load({ BREVO_API_KEY: 'k', MAIL_FROM: 'team@resumematch.ph' });
  let body: any = null;
  globalThis.fetch = (async (_u: any, init: any) => { body = JSON.parse(init.body); return new Response('', { status: 201 }); }) as any;
  try { await m.sendMail('a@b.com', 's', 't', '<p>h</p>'); } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(body.sender, { email: 'team@resumematch.ph' });
});
