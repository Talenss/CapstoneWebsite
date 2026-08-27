/* Linaw PH — tests/helpers/smtp-sink.ts

   A minimal SMTP server that accepts a message and keeps it in memory, so
   the mail path can be tested for real: nodemailer -> TCP -> SMTP dialogue
   -> a message we can assert on. Previously the only thing exercised was
   the DEBUG branch that prints codes to the console, which is the one path
   that never runs in production.

   Deliberately dependency-free. SMTP is a small line protocol and we only
   need the subset nodemailer speaks for a plain unauthenticated send; a
   package for this would be a production dependency carried for tests. */
import net from 'node:net';

export interface CapturedMail {
  from: string;
  to: string[];
  /** The raw DATA block, headers and body. */
  raw: string;
  subject: string;
  /** Decoded body text with quoted-printable and soft line breaks resolved. */
  body: string;
}

/** Headers arrive quoted-printable-encoded and folded across lines. */
function decodeSubject(raw: string): string {
  const m = /^Subject:\s*((?:.*(?:\r?\n[ \t].*)*))/mi.exec(raw);
  if (!m) return '';
  let s = m[1].replace(/\r?\n[ \t]/g, '');
  // =?UTF-8?Q?...?= / =?UTF-8?B?...?=
  s = s.replace(/=\?[^?]+\?([QqBb])\?([^?]*)\?=/g, (_all, enc, txt) => {
    if (enc.toLowerCase() === 'b') return Buffer.from(txt, 'base64').toString('utf8');
    return txt.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g,
      (_m2, h) => String.fromCharCode(parseInt(h, 16)));
  });
  return s.trim();
}

function decodeBody(raw: string): string {
  const idx = raw.indexOf('\r\n\r\n');
  let body = idx === -1 ? raw : raw.slice(idx + 4);
  // quoted-printable: soft line breaks then hex escapes
  body = body.replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  return body;
}

export class SmtpSink {
  readonly messages: CapturedMail[] = [];
  private server: net.Server | null = null;
  port = 0;

  async start(): Promise<number> {
    this.server = net.createServer((socket) => {
      let buffer = '';
      let inData = false;
      let dataLines: string[] = [];
      let from = '';
      let to: string[] = [];

      const send = (line: string) => socket.write(line + '\r\n');
      send('220 linaw-test-sink ESMTP');

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        for (;;) {
          const nl = buffer.indexOf('\r\n');
          if (nl === -1) break;
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);

          if (inData) {
            if (line === '.') {
              inData = false;
              const raw = dataLines.join('\r\n');
              this.messages.push({
                from, to: [...to], raw,
                subject: decodeSubject(raw),
                body: decodeBody(raw),
              });
              dataLines = []; to = [];
              send('250 2.0.0 Ok: queued');
            } else {
              // dot-stuffing: a leading '.' is doubled on the wire
              dataLines.push(line.startsWith('..') ? line.slice(1) : line);
            }
            continue;
          }

          const upper = line.toUpperCase();
          if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
            // No STARTTLS and no AUTH advertised — keeps the dialogue plain,
            // which is what the test transport is configured for.
            send('250-linaw-test-sink');
            send('250 8BITMIME');
          } else if (upper.startsWith('MAIL FROM')) {
            from = (/<([^>]*)>/.exec(line) || [, ''])[1];
            send('250 2.1.0 Ok');
          } else if (upper.startsWith('RCPT TO')) {
            to.push((/<([^>]*)>/.exec(line) || [, ''])[1]);
            send('250 2.1.5 Ok');
          } else if (upper === 'DATA') {
            inData = true;
            send('354 End data with <CR><LF>.<CR><LF>');
          } else if (upper === 'RSET') {
            to = []; from = ''; send('250 2.0.0 Ok');
          } else if (upper === 'QUIT') {
            send('221 2.0.0 Bye'); socket.end();
          } else {
            send('250 2.0.0 Ok');
          }
        }
      });
      socket.on('error', () => { /* client hang-ups are normal here */ });
    });

    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server!.address() as net.AddressInfo).port;
    return this.port;
  }

  /** Wait until a message matching `pred` arrives, or throw after `ms`. */
  async waitFor(pred: (m: CapturedMail) => boolean, ms = 8000): Promise<CapturedMail> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.messages.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(`no matching email within ${ms}ms; captured ${this.messages.length}: `
          + this.messages.map((m) => `${m.to.join(',')} "${m.subject}"`).join(' | '));
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  clear(): void { this.messages.length = 0; }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = null;
  }
}
