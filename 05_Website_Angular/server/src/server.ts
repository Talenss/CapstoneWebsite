/* ============================================================
   ResumeMatch PH — Node/Express API server
   ------------------------------------------------------------
   Port of the api/*.php endpoints (PDO+MySQL) to Express+TypeScript
   (mysql2+MySQL). Same database, same schema, same JSON contract
   philosophy as api/_lib.php — see src/lib/engine.ts and
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
import { PORT, ALLOW_ORIGIN, SESSION_SECRET, UPLOAD_DIR, DEBUG, TRUST_PROXY, COOKIE_SECURE, IS_PROD } from './config';

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
  name: 'rmph.sid',
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
   feature catches up on first boot (a fresh db/resumematch_ph.sql has nothing
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
runMigrations().then(
  () => listen(),
  (e) => {
    const why = e?.message || e;
    if (IS_PROD) {
      console.error('Schema migration FAILED — refusing to start:', why);
      console.error('The database is unreachable or the connecting role cannot alter the schema.');
      process.exit(1);
    }
    console.error('Schema migration failed (is the database reachable?):', why);
    console.error('Continuing in development — API routes that touch these tables may fail.');
    listen();
  },
);

function listen(): void {
  app.listen(PORT, () => {
    console.log(`ResumeMatch PH API listening on http://localhost:${PORT}`);
  });
}
