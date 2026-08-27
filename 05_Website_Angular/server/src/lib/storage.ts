/* ============================================================
   Linaw PH — lib/storage.ts
   ------------------------------------------------------------
   Where an applicant's uploaded resume file actually lives.

   TWO BACKENDS, ONE INTERFACE:

     · disk      — a folder on the server. The default, and what
                   local development uses. Needs no account and
                   no network.
     · supabase  — Supabase Storage, over its REST API.

   WHY SUPABASE IS THE ONE FOR A REAL DEPLOYMENT. Most Node
   hosts (Render, Railway, Fly on their free and hobby tiers)
   give the process an EPHEMERAL filesystem: every redeploy,
   restart or sleep hands back a blank disk. The database rows
   survive, so a resume would still be listed, still be scored,
   still be sent to a recruiter — and the file behind it would
   be gone. Supabase Storage is durable and independent of the
   process, so a redeploy costs nothing.

   Selection is by configuration, not by code: set
   SUPABASE_URL and SUPABASE_SERVICE_KEY and this switches to
   Supabase; leave either empty and it stays on disk. Nothing
   above this file knows which is in use.

   NO SDK. Supabase Storage is a plain REST API and Node 22 has
   fetch built in, so this is three HTTP calls rather than a
   dependency. Keys are stored under a bucket that must NOT be
   public: every read goes through routes/file.ts, which checks
   that the caller is the applicant or a recruiter the resume
   was actually sent to. A public bucket would make a resume
   reachable by guessing a URL, which is precisely what the
   route exists to prevent.
   ============================================================ */
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
