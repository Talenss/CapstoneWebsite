/* ============================================================
   Linaw PH — Node/Express API server
   ------------------------------------------------------------
   Port of the api/*.php endpoints (PDO+MySQL) to Express+TypeScript
   on PostgreSQL. The schema and the JSON contract carried over
   unchanged; only the database engine beneath them changed. Same
   contract philosophy as api/_lib.php — see src/lib/engine.ts and
   src/lib/serializers.ts for the 1:1 ports of the matching engine
   and row serializers.
   ============================================================ */
import express from 'express';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { PORT, ALLOW_ORIGIN, SESSION_SECRET, UPLOAD_DIR, DEBUG, TRUST_PROXY, COOKIE_SECURE, IS_PROD , DATABASE_URL, DB_HOST, DB_PORT, DB_NAME, DB_USER } from './config';

import authRoutes from './routes/auth';
import companiesRoutes from './routes/companies';
import resumesRoutes from './routes/resumes';
import postingsRoutes from './routes/postings';
import applicationsRoutes from './routes/applications';
import matchRoutes from './routes/match';
import statsRoutes from './routes/stats';
import fileRoutes from './routes/file';
import analyzeRoutes from './routes/analyze';
import adminRoutes from './routes/admin';
import savedRoutes from './routes/saved';
import metricsRoutes from './routes/metrics';
import { runMigrations } from './lib/migrate';
import { db } from './db';

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();

// Behind an HTTPS reverse proxy, TRUST_PROXY=true makes X-Forwarded-*
// trustworthy (real client IPs for the rate limiters, https detection).
if (TRUST_PROXY) app.set('trust proxy', 1);

// Security headers. The CSP allows what the Angular app actually uses:
// its own bundles, inline style bindings, Google Fonts, and same-origin
// API/file requests (demo-mode file previews use data:/blob: URLs).
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      frameSrc: ["'self'", 'data:', 'blob:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false, // would block the Google Fonts stylesheet
}));

app.use(cors({ origin: ALLOW_ORIGIN, credentials: true }));
app.use(express.json({ limit: '2mb' }));

/* Sessions live in Postgres, not in the process.
 *
 * express-session's default MemoryStore keeps every session in a variable, so
 * a restart — a deploy, a crash, the free-tier host idling the dyno — signed
 * everybody out, and nothing ever pruned expired entries. Storing them in the
 * database the app already has means a restart is invisible to whoever is
 * mid-application, and expired rows are swept on a timer.
 *
 * The table is created here rather than by the library's own bundled SQL so
 * it exists before the first request, on a fresh database and an upgraded one
 * alike. */
app.use(session({
  name: 'linaw.sid',
  store: new (pgSession(session))({
    pool: db(),
    tableName: 'user_sessions',
    createTableIfMissing: true,
    pruneSessionInterval: 60 * 15,   // seconds
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE, // COOKIE_SECURE=true in .env when serving over HTTPS
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
}));

app.use('/api/auth', authRoutes);
app.use('/api/companies', companiesRoutes);
app.use('/api/resumes', resumesRoutes);
app.use('/api/postings', postingsRoutes);
app.use('/api/applications', applicationsRoutes);
app.use('/api/match', matchRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/file', fileRoutes);
app.use('/api/analyze', analyzeRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/saved', savedRoutes);
app.use('/api/metrics', metricsRoutes);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// In production, serve the built Angular app from the same origin as
// the API — this keeps the session cookie same-site with no CORS needed.
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist', 'client', 'browser');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  // Multer reports an oversized upload here rather than in the route, so it
  // needs its own message — otherwise a 2 MB file reads as a server outage.
  if (err?.code === 'LIMIT_FILE_SIZE')
    return res.status(413).json({ ok: false, error: 'That file is too large. The limit is 2 MB.' });
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: DEBUG ? String(err?.message || err) : 'The service is unavailable. Try again shortly.' });
});

/* Last line of defence. Routers use asyncRouter(), so a rejected handler is
   already forwarded to the error middleware above — but a rejection raised
   outside a request (a fire-and-forget notification, a callback that Express
   never awaits) would otherwise reach Node's default handler, which since
   v15 EXITS THE PROCESS. Logging and staying up is the right trade for a
   pilot deployment: one broken request must not take the API down for
   everyone. */
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] request survived, server staying up:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] server staying up:', err);
});

/* Idempotent, additive schema upgrades so a database created before a given
   feature catches up on first boot (a fresh db/linaw_ph.sql has nothing
   to do).

   This is deliberately AWAITED before the port opens. Previously it was
   fire-and-forget, which had two consequences worth stating plainly:

     · Requests arriving during the migration hit a half-upgraded schema —
       a real race on a cold start, not a theoretical one.
     · A FAILED migration was logged and then ignored, so the server went on
       serving against a schema it had just failed to correct. The symptom
       is not an obvious outage but a scattering of confusing 500s much
       later — e.g. a seeker withdrawing an application against a CHECK
       constraint that was never widened to allow 'withdrawn'.

   In production a schema we could not verify is a reason not to start: a
   deployment that fails loudly at boot is far cheaper to diagnose than one
   that half-works for a week. In development we warn and continue, so the
   demo bundle still serves on a laptop with no database configured. */
/* Say where we are about to connect, before trying. A failed connection
   reports what the DATABASE tells us ("tenant not found", "password
   authentication failed"), never what we ASKED FOR — so when a deployment
   has a stale or mistyped value, the logs describe a database nobody meant
   to reach and the search goes looking in the wrong place. Printing the
   target first turns "why is it saying that" into a one-line comparison.
   The password is never printed. */
logDatabaseTarget();

runMigrations().then(
  () => listen(),
  (e) => {
    const why = e?.message || e;
    if (IS_PROD) {
      console.error('Schema migration FAILED — refusing to start:', why);
      /* The commonest cause by a distance, and the one the generic message
         below sends people hunting for in the wrong place: DATABASE_URL is
         simply not set on this service, so the connection fell back to a
         local Postgres that was never going to be there. It happens whenever
         a blueprint stands up a NEW service, because every secret in
         render.yaml is `sync: false` and a new service starts with none of
         them. Say so, rather than making the reader infer it from the
         "(from DB_* settings)" line printed a moment earlier. */
      if (!DATABASE_URL) {
        console.error('DATABASE_URL is NOT SET on this service, so the fallback DB_* settings were used —');
        console.error(`that is why the target above reads ${DB_HOST}:${DB_PORT}, which is this container itself.`);
        console.error('Set DATABASE_URL (Supabase -> Project Settings -> Database -> Session pooler),');
        console.error('along with the other values render.yaml marks `sync: false`.');
      } else {
        console.error('The database is unreachable or the connecting role cannot alter the schema.');
      }
      process.exit(1);
    }
    console.error('Schema migration failed (is the database reachable?):', why);
    console.error('Continuing in development — API routes that touch these tables may fail.');
    listen();
  },
);

/** Log the database we are about to use, with the password masked. */
function logDatabaseTarget(): void {
  if (DATABASE_URL) {
    const m = /^postgres(?:ql)?:\/\/([^:]+):[^@]*@([^/?]+)\/?([^?]*)/.exec(DATABASE_URL);
    if (m) {
      console.log(`Database target: ${m[1]}@${m[2]}/${m[3] || 'postgres'}  (from DATABASE_URL)`);
      if (/^db\.[a-z0-9]+\.supabase\.co/.test(m[2])) {
        console.log('  NOTE: that is Supabase\'s DIRECT host, which is IPv6-only.');
        console.log('  Hosts without outbound IPv6 (Render among them) cannot reach it.');
        console.log('  Use the SESSION POOLER string: Supabase -> Project Settings -> Database.');
      }
    } else {
      console.log('Database target: DATABASE_URL is set but could not be parsed.');
    }
    return;
  }
  console.log(`Database target: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}  (from DB_* settings)`);
}

function listen(): void {
  app.listen(PORT, () => {
    console.log(`Linaw PH API listening on http://localhost:${PORT}`);
  });
}
