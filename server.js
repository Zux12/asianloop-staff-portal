require('dotenv').config();
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { ImapFlow } = require('imapflow');

const app = express();

// ---------- Config ----------
const {
  IMAP_HOST = 'imap.hostinger.com',
  IMAP_PORT = 993,
  IMAP_SECURE = 'true',
  ALLOWED_DOMAIN = '@asian-loop.com',
  ALLOWLIST = '',
  SESSION_SECRET = 'please-change',
  SESSION_NAME = 'al_sess',
  SESSION_SECURE = 'true'
} = process.env;

const allowlist = ALLOWLIST.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const path = require('path');

// Serve root assets needed by public pages
app.get('/logo.jpg', (req, res) => {
  res.sendFile(path.join(__dirname, 'logo.jpg'));
});

app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'favicon.ico'));
});

// Health check (quick 200 for uptime checks)
app.get('/healthz', (req, res) => res.type('text').send('ok'));

// Explicit HEAD handlers (avoid hangs on some platforms)
app.head('/', (req, res) => res.status(200).end());
app.head('/dashboard', requireAuth, (req, res) => res.status(200).end());


// Public: privacy page
app.get('/privacy', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'privacy.html'));
});

// ---------- Middleware ----------
app.set('trust proxy', 1); // Heroku

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Sessions (MemoryStore OK for MVP; switch to Redis for production scale)
app.use(session({
  name: SESSION_NAME,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: SESSION_SECURE === 'true'
  }
}));

// Rate-limit login to slow brute force
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15m
  max: 20, // 20 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false
});

// ---------- Helpers ----------
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect('/');
}

// Serve static assets only AFTER auth (for dashboard assets)
// Public login assets remain open:
app.use('/public/css/login.css', express.static(path.join(__dirname, 'public/css/login.css')));
app.use('/public', requireAuth, express.static(path.join(__dirname, 'public')));

// ---------- Routes ----------

// Login page
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// POST /login
app.post('/login', loginLimiter, async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';

    if (!email || !password) return res.status(400).send('Missing email or password.');
    if (!email.endsWith(ALLOWED_DOMAIN)) return res.status(403).send('Invalid domain.');
    if (allowlist.length && !allowlist.includes(email)) return res.status(403).send('Not authorized.');

    // IMAP auth attempt (no password stored)
    const client = new ImapFlow({
      host: IMAP_HOST,
      port: Number(IMAP_PORT),
      secure: IMAP_SECURE === 'true',
      auth: { user: email, pass: password },
      logger: false
    });

    await client.connect();
    await client.logout();

    // success: create session
    req.session.user = { email };
    return res.status(200).send('OK');
  } catch (err) {
    // Generic failure (don’t leak which part failed)
    return res.status(401).send('Invalid email or password.');
  }
});

// Dashboard (protected)
app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Logout
app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// Fallback: 404
app.use((req, res) => res.status(404).send('Not found'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Staff portal running on ${PORT}`));

