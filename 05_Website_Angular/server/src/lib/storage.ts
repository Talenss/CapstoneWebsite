/* Where an applicant's uploaded file lives. Two backends behind one
   interface: a folder on disk (the default, and what development uses), or
   Supabase Storage.

   Supabase is the one for a real deployment because Render's filesystem is
   ephemeral — a redeploy hands back a blank disk while the rows pointing at
   those files survive, so a resume would still be listed, still scored, still
   sent to a recruiter, with nothing behind it.

   Selected by configuration, not code: set SUPABASE_URL and
   SUPABASE_SERVICE_KEY and it switches. Nothing above this file knows which
   is in use. No SDK — it is a REST API and Node has fetch, so this is three
   HTTP calls rather than a dependency. The bucket must NOT be public: reads
   go through routes/file.ts, which checks the caller is the applicant or a
   recruiter the resume was sent to. */
import fs from 'fs';
import path from 'path';
import { UPLOAD_DIR, SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_BUCKET } from '../config';

export type StorageBackend = 'disk' | 'supabase';

export function storageBackend(): StorageBackend {
  return SUPABASE_URL && SUPABASE_SERVICE_KEY ? 'supabase' : 'disk';
}

/* basename() everywhere a key is used: a crafted database value must never
   be able to walk out of the folder (disk) or out of the bucket prefix
   (Supabase). The keys this module writes are random hex, but the read and
   delete paths take whatever the row holds. */
const safeKey = (key: string) => path.basename(key);

function objectUrl(key: string): string {
  return `${SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/${encodeURIComponent(SUPABASE_BUCKET)}/${encodeURIComponent(safeKey(key))}`;
}

const authHeaders = () => ({
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  apikey: SUPABASE_SERVICE_KEY,
});

/** Store bytes under `key`, replacing anything already there. */
export async function putFile(key: string, body: Buffer, mime: string): Promise<void> {
  if (storageBackend() === 'disk') {
    fs.writeFileSync(path.join(UPLOAD_DIR, safeKey(key)), body);
    return;
  }
  const res = await fetch(objectUrl(key), {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': mime || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: new Uint8Array(body),
  });
  if (!res.ok) {
    throw new Error(`Supabase Storage upload failed (${res.status}): ${await res.text()}`);
  }
}

/** Read the bytes back, or null when the object is not there. */
export async function getFile(key: string): Promise<Buffer | null> {
  if (storageBackend() === 'disk') {
    const p = path.join(UPLOAD_DIR, safeKey(key));
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }
  const res = await fetch(objectUrl(key), { headers: authHeaders() });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`Supabase Storage read failed (${res.status}): ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

/* Deleting a file the user has replaced or removed is housekeeping, not the
   point of the request that triggered it. A storage error here must not fail
   an account deletion or a re-upload, so this never throws — the worst case
   is an orphaned object, which costs storage and nothing else. */
export async function deleteFile(key: string): Promise<void> {
  try {
    if (storageBackend() === 'disk') {
      const p = path.join(UPLOAD_DIR, safeKey(key));
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return;
    }
    await fetch(objectUrl(key), { method: 'DELETE', headers: authHeaders() });
  } catch {
    /* orphan left behind; nothing the caller can usefully do */
  }
}
