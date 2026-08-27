/* Linaw PH — tests/storage.test.ts

   lib/storage.ts decides where an applicant's uploaded resume actually
   lives, and it has two backends that must behave identically to every
   caller above it. These tests pin both:

     · the disk backend — a real round trip through a temp folder
     · the Supabase backend — the exact HTTP the REST API is given,
       checked against a stubbed fetch, since the real one needs an
       account and a network

   They also pin sniffBytes against sniffFileType, because the upload
   route stopped writing a temp file and now sniffs in memory: if those
   two ever disagree, a file accepted on one path would be refused on
   the other. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'linaw-storage-'));

/** Load config + storage fresh, so each test picks its own backend. */
function loadStorage(env: Record<string, string>) {
  for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_BUCKET', 'UPLOAD_DIR']) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/lib/storage')];
  return require('../src/lib/storage') as typeof import('../src/lib/storage');
}

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('body bytes')]);

test('disk backend: put, get and delete round-trip', async () => {
  const s = loadStorage({ UPLOAD_DIR: TMP });
  assert.equal(s.storageBackend(), 'disk');

  await s.putFile('abc123.pdf', PDF, 'application/pdf');
  assert.ok(fs.existsSync(path.join(TMP, 'abc123.pdf')), 'the file should be on disk');
  assert.deepEqual(await s.getFile('abc123.pdf'), PDF);

  await s.deleteFile('abc123.pdf');
  assert.equal(await s.getFile('abc123.pdf'), null, 'a deleted file reads back as null, not an error');
});

test('disk backend: a missing object reads as null rather than throwing', async () => {
  const s = loadStorage({ UPLOAD_DIR: TMP });
  assert.equal(await s.getFile('never-written.pdf'), null);
});

test('a traversing key cannot escape the upload folder', async () => {
  const s = loadStorage({ UPLOAD_DIR: TMP });
  await s.putFile('../escaped.pdf', PDF, 'application/pdf');
  assert.ok(!fs.existsSync(path.join(TMP, '..', 'escaped.pdf')), 'must not write outside UPLOAD_DIR');
  assert.ok(fs.existsSync(path.join(TMP, 'escaped.pdf')), 'the key is basenamed, so it lands inside');
});

/* ---------- Supabase backend, against a stubbed fetch ---------- */

type Call = { url: string; init: any };
function stubFetch(reply: (c: Call) => Response): Call[] {
  const calls: Call[] = [];
  (globalThis as any).fetch = async (url: any, init: any) => {
    const c = { url: String(url), init: init || {} };
    calls.push(c);
    return reply(c);
  };
  return calls;
}

const SB = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_KEY: 'service-key-xyz', SUPABASE_BUCKET: 'resumes' };
const realFetch = globalThis.fetch;

test('supabase backend is selected only when url AND key are both set', () => {
  assert.equal(loadStorage({ ...SB, UPLOAD_DIR: TMP }).storageBackend(), 'supabase');
  assert.equal(loadStorage({ SUPABASE_URL: SB.SUPABASE_URL, UPLOAD_DIR: TMP }).storageBackend(), 'disk',
    'a url with no key must not silently half-enable the remote backend');
  assert.equal(loadStorage({ SUPABASE_SERVICE_KEY: SB.SUPABASE_SERVICE_KEY, UPLOAD_DIR: TMP }).storageBackend(), 'disk');
});

test('supabase put: correct object URL, auth headers and upsert', async () => {
  const s = loadStorage({ ...SB, UPLOAD_DIR: TMP });
  const calls = stubFetch(() => new Response('', { status: 200 }));
  try {
    await s.putFile('abc123.pdf', PDF, 'application/pdf');
  } finally { globalThis.fetch = realFetch; }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://proj.supabase.co/storage/v1/object/resumes/abc123.pdf');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer service-key-xyz');
  assert.equal(calls[0].init.headers.apikey, 'service-key-xyz');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/pdf');
  assert.equal(calls[0].init.headers['x-upsert'], 'true', 'replacing a resume must overwrite, not 409');
});

test('supabase put: a failed upload throws, so the route can refuse the upload', async () => {
  const s = loadStorage({ ...SB, UPLOAD_DIR: TMP });
  stubFetch(() => new Response('bucket not found', { status: 404 }));
  try {
    await assert.rejects(() => s.putFile('x.pdf', PDF, 'application/pdf'), /Supabase Storage upload failed \(404\)/);
  } finally { globalThis.fetch = realFetch; }
});

test('supabase get: returns the bytes, and null on a missing object', async () => {
  const s = loadStorage({ ...SB, UPLOAD_DIR: TMP });
  stubFetch(() => new Response(new Uint8Array(PDF), { status: 200 }));
  try {
    assert.deepEqual(await s.getFile('abc123.pdf'), PDF);
  } finally { globalThis.fetch = realFetch; }

  stubFetch(() => new Response('', { status: 404 }));
  try {
    assert.equal(await s.getFile('gone.pdf'), null);
  } finally { globalThis.fetch = realFetch; }
});

test('supabase delete: issues DELETE, and never throws on failure', async () => {
  const s = loadStorage({ ...SB, UPLOAD_DIR: TMP });
  const calls = stubFetch(() => new Response('nope', { status: 500 }));
  try {
    await s.deleteFile('abc123.pdf'); // must not throw: housekeeping, not the request's purpose
  } finally { globalThis.fetch = realFetch; }
  assert.equal(calls[0].init.method, 'DELETE');
});

test('supabase keys are url-encoded, and traversal is stripped', async () => {
  const s = loadStorage({ ...SB, UPLOAD_DIR: TMP });
  const calls = stubFetch(() => new Response('', { status: 200 }));
  try {
    await s.putFile('../../etc/passwd', PDF, 'application/pdf');
  } finally { globalThis.fetch = realFetch; }
  assert.equal(calls[0].url, 'https://proj.supabase.co/storage/v1/object/resumes/passwd');
});

/* ---------- the in-memory sniffer must agree with the on-disk one ---------- */

test('sniffBytes agrees with sniffFileType on every accepted format', () => {
  const { sniffBytes, sniffFileType } = require('../src/lib/file-type') as typeof import('../src/lib/file-type');
  const samples: Record<string, Buffer> = {
    pdf: Buffer.from('%PDF-1.7 rest'),
    jpg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]),
    png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    doc: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    docx: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
  };
  for (const [expected, buf] of Object.entries(samples)) {
    const p = path.join(TMP, `sniff.${expected}`);
    fs.writeFileSync(p, buf);
    assert.equal(sniffBytes(buf), expected, `sniffBytes should read ${expected}`);
    assert.equal(sniffFileType(p), expected, `sniffFileType should agree on ${expected}`);
  }
  assert.equal(sniffBytes(Buffer.from('just text')), null, 'an arbitrary blob is refused');
  assert.equal(sniffBytes(Buffer.from([0x25])), null, 'too few bytes to judge is refused');
});
