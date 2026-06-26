require('dotenv/config');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const path = require('node:path');
const auth = require('./auth.js');
const { registerRoutes } = require('./bff.js');

const PORT = process.env.PORT || 3001;
const DESKTOP_RENDERER = process.env.DESKTOP_RENDERER_DIR
  ? path.resolve(process.env.DESKTOP_RENDERER_DIR)
  : path.join(__dirname, '../../desktop/src/renderer');
const PUBLIC_DIR = process.env.PUBLIC_DIR
  ? path.resolve(process.env.PUBLIC_DIR)
  : path.join(__dirname, '../public');

const app = express();

function authCookieOptions(maxAge) {
  const options = { httpOnly: true, sameSite: 'lax', maxAge };
  if (process.env.NODE_ENV === 'production') options.secure = true;
  return options;
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cookieParser());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Vendor files (referenced by desktop renderer's index.html) ───────────────

app.get('/vendor/jszip.min.js', (_req, res) => {
  res.sendFile(require.resolve('jszip/dist/jszip.min.js'));
});

// docx-preview is a desktop-only dependency; serve a harmless no-op stub so
// the renderer's script tag doesn't 404 and break page load.
app.get('/vendor/docx-preview.min.js', (_req, res) => {
  res.type('text/javascript').send('/* docx-preview not bundled in web version */');
});

app.get('/vendor/pdf.mjs', (_req, res) => {
  try {
    res.type('text/javascript').sendFile(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
  } catch {
    res.type('text/javascript').send('/* pdfjs not bundled in web version */');
  }
});
app.get('/vendor/pdf.worker.mjs', (_req, res) => {
  try {
    res.type('text/javascript').sendFile(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'));
  } catch {
    res.type('text/javascript').send('/* pdfjs not bundled in web version */');
  }
});

// ─── Auth routes ──────────────────────────────────────────────────────────────

app.get('/login', (_req, res) => {
  try {
    const login = auth.beginLogin();
    res.cookie('co_login_state', JSON.stringify(login.loginState), authCookieOptions(10 * 60 * 1000));
    res.redirect(login.url);
  } catch (err) {
    res.status(500).send(`Configuration error: ${err.message}`);
  }
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.redirect('/login');

    const loginState = req.cookies.co_login_state ? JSON.parse(req.cookies.co_login_state) : null;
    const tokens = await auth.completeLogin(String(code), String(state), loginState);
    const cookieOpts = authCookieOptions(30 * 24 * 60 * 60 * 1000);
    res.clearCookie('co_login_state');

    res.cookie('co_access_token', tokens.access_token, cookieOpts);
    if (tokens.refresh_token) res.cookie('co_refresh_token', tokens.refresh_token, cookieOpts);

    // Check whether the user has already completed onboarding
    try {
      const stateInfo = await onboardingState(tokens.access_token);
      if (!stateInfo?.completedAt) return res.redirect('/onboarding');
    } catch {
      // If the profile check fails, proceed to the app — better than a stuck login loop
    }

    res.redirect('/');
  } catch (err) {
    console.error('Auth callback error:', err.message);
    res.redirect('/login?error=callback_failed');
  }
});

app.get('/logout', (req, res) => {
  res.clearCookie('co_access_token');
  res.clearCookie('co_refresh_token');
  res.clearCookie('co_onboarded');
  res.clearCookie('co_login_state');
  try {
    res.redirect(auth.logoutUrl());
  } catch {
    res.redirect('/login');
  }
});

// ─── Auth middleware ───────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.cookies.co_access_token) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect('/login');
}

async function onboardingState(accessToken) {
  const response = await fetch(`${process.env.CLOUD_API_URL}/v1/onboarding/state`, {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) return null;
  return response.json();
}

// ─── Onboarding page ──────────────────────────────────────────────────────────

app.get('/onboarding', requireAuth, async (req, res) => {
  try {
    const stateInfo = await onboardingState(req.cookies.co_access_token);
    if (stateInfo?.completedAt) return res.redirect('/');
  } catch {}
  res.sendFile(path.join(PUBLIC_DIR, 'onboarding.html'));
});

// ─── BFF API routes (all require auth) ────────────────────────────────────────

app.use('/api', requireAuth);
registerRoutes(app);

// ─── Desktop renderer as main app (static, auth-gated) ───────────────────────

app.get('/', requireAuth, async (req, res) => {
  try {
    const stateInfo = await onboardingState(req.cookies.co_access_token);
    if (stateInfo && !stateInfo.completedAt) return res.redirect('/onboarding');
  } catch {}
  res.sendFile(path.join(DESKTOP_RENDERER, 'index.html'));
});

// Serve desktop renderer static files (fonts, styles.css, renderer.js, etc.)
// Note: /vendor/* is handled above; this catches everything else.
app.use(requireAuth, express.static(DESKTOP_RENDERER));

// ─── Error handler ────────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(JSON.stringify({ level: 'error', error: err.message, stack: err.stack }));
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Career Ops web server running at http://localhost:${PORT}`);
    console.log('  Main app: http://localhost:' + PORT + '/');
    console.log('  Onboarding: http://localhost:' + PORT + '/onboarding');
  });
}

module.exports = app;
