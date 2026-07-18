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
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { PORT, ALLOW_ORIGIN, SESSION_SECRET, UPLOAD_DIR, DEBUG, TRUST_PROXY, COOKIE_SECURE } from './config';

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
import { runMigrations } from './lib/migrate';

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Additive schema upgrades (email_codes table, notification preference
// column) — databases imported from the original 04_Website schema
// upgrade themselves on first boot.
runMigrations().catch((e) =>
  console.error('Schema migration failed (is MySQL running?):', e?.message || e));

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

app.use(session({
  name: 'rmph.sid',
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
  res.status(500).json({ ok: false, error: DEBUG ? String(err?.message || err) : 'The service is unavailable. Try again shortly.' });
});

app.listen(PORT, () => {
  console.log(`ResumeMatch PH API listening on http://localhost:${PORT}`);
});
