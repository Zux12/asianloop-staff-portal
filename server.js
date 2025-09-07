require('dotenv').config();
const { MongoClient, ObjectId, GridFSBucket } = require('mongodb');
const path = require('path');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);

// -------- Config (from env) --------
const {
  IMAP_HOST = 'imap.hostinger.com',
  IMAP_PORT = '993',
  IMAP_SECURE = 'true',
  ALLOWED_DOMAIN = '@asian-loop.com',
  ALLOWLIST = '',
  SESSION_SECRET = 'change-me',
  SESSION_NAME = 'al_sess',
  SESSION_SECURE = 'true'
} = process.env;

const { MONGO_URI = '' } = process.env;  // set in Heroku Config Vars

const allowlist = ALLOWLIST.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const cookieOptionsDisplay = {
  sameSite: 'lax',
  secure: true,          // stays true since HTTPS is active
  httpOnly: false,       // must be readable by JS for display
  maxAge: 60 * 60 * 1000 // 1 hour
};



// -------- Middleware --------
app.use(express.urlencoded({ extended: true })); // handles POST form
app.use(express.json());
app.get('/error', (req, res) => {
  res.status(401).sendFile(require('path').join(__dirname, 'error.html'));
});

app.get('/me', requireAuth, (req, res) => {
  res.json(req.session.user); // { email }
});


app.use(session({
  name: SESSION_NAME,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: SESSION_SECURE === 'true' // set true once HTTPS works (it does now ✅)
  }
}));

app.use('/msbs', express.static(path.join(__dirname, 'msbs')));

// --- MBS pretty URLs -> static HTML files ---
const fs = require('fs');
const MBS_DIR = path.join(__dirname, 'msbs');

// Entry: /msbs -> msbs-overview.html
app.get(['/msbs', '/msbs/'], requireAuth, (req, res) => {
  res.sendFile(path.join(MBS_DIR, 'msbs-overview.html'));
});

// Internal home: /msbs/internal -> msbs-internal.html
app.get('/msbs/internal', requireAuth, (req, res) => {
  res.sendFile(path.join(MBS_DIR, 'msbs-internal.html'));
});

// Internal subpages: /msbs/internal/:page -> msbs-internal-:page.html
app.get('/msbs/internal/:page', requireAuth, (req, res, next) => {
  const file = path.join(MBS_DIR, `msbs-internal-${req.params.page}.html`);
  fs.access(file, fs.constants.F_OK, err => err ? next() : res.sendFile(file));
});

// Public subpages: /msbs/:page -> msbs-:page.html
app.get('/msbs/:page', requireAuth, (req, res, next) => {
  const file = path.join(MBS_DIR, `msbs-${req.params.page}.html`);
  fs.access(file, fs.constants.F_OK, err => err ? next() : res.sendFile(file));
});





// Rate-limit login attempts
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});

// -------- Auth helpers --------
function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  return res.redirect('/');
}

// -------- Static & root assets --------
// Publicly available CSS (needed on login)
// Publicly available assets for login page
app.use('/public/css', express.static(path.join(__dirname, 'public/css')));
app.use('/public/images', express.static(path.join(__dirname, 'public/images')));

// All other /public assets require auth
app.use('/public', requireAuth, express.static(path.join(__dirname, 'public')));

// Root assets
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'favicon.ico')));



// -------- Mongo (Atlas) --------
let db, gfs;
(async function connectMongo(){
  if (!MONGO_URI) {
    console.warn('MONGO_URI is not set; /api/msbs/* will respond 503');
    return;
  }
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db(); // database comes from the URI path
    gfs = new GridFSBucket(db, { bucketName: 'msbsFiles' });
    console.log('Mongo connected • db:', db.databaseName);
  } catch (e) {
    console.error('Mongo connect error:', e.message);
  }
})();

// -------- MBS: API (read-only) --------

// Announcements (public view)
app.get('/api/msbs/announcements', requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not ready' });
  try {
    const now = new Date();
    const items = await db.collection('msbs_announcements')
      .find({
        $or: [
          { startsAt: { $exists: false } },
          { startsAt: { $lte: now } }
        ],
        $or2: [
          { endsAt: { $exists: false } },
          { endsAt: { $gte: now } }
        ]
      }, { projection: { title:1, body:1, pinned:1, createdAt:1, authorEmail:1 } })
      .sort({ pinned: -1, createdAt: -1 })
      .limit(20)
      .toArray();
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Branding assets (public links + GridFS)
app.get('/api/msbs/brand-assets', requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not ready' });
  try {
    const items = await db.collection('msbs_brand_assets')
      .find({}, { projection: { title:1, kind:1, ext:1, bytes:1, fileId:1, url:1 } })
      .sort({ title: 1 })
      .toArray();

    // normalize to href (prefer GridFS fileId; fallback to url)
    const normalized = items.map(x => ({
      title: x.title,
      kind: x.kind,
      href: x.fileId ? `/files/${x.fileId}` : (x.url || '#')
    }));
    res.json(normalized);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GridFS downloader: /files/:id
app.get('/files/:id', requireAuth, async (req, res) => {
  if (!db || !gfs) return res.status(503).type('text').send('DB not ready');
  try {
    const _id = new ObjectId(req.params.id);
    // Probe file doc for contentType/filename
    const fileDoc = await db.collection('msbsFiles.files').findOne({ _id });
    if (!fileDoc) return res.status(404).type('text').send('File not found');

    if (fileDoc.contentType) res.set('Content-Type', fileDoc.contentType);
    res.set('Content-Disposition', `inline; filename="${fileDoc.filename || 'file'}"`);

    gfs.openDownloadStream(_id).on('error', () => res.status(404).end()).pipe(res);
  } catch (_) {
    res.status(400).type('text').send('Bad file id');
  }
});


// -------- Pages --------
app.get('/', (req, res) => {
  if (req.session?.user) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Test dashboard (auth-protected)
app.get('/testdash', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'testdash.html'));
});


app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'privacy.html'));
});

// -------- Login / Logout --------
app.post('/login', loginLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) return res.status(400).send('Missing email or password.');
    if (!email.endsWith(ALLOWED_DOMAIN)) return res.status(403).send('Invalid domain.');
    if (allowlist.length && !allowlist.includes(email)) return res.status(403).send('Not authorized.');

    // Lazy-load imapflow so the app can still boot even if module install lags
    const { ImapFlow } = require('imapflow');

    const client = new ImapFlow({
      host: IMAP_HOST,
      port: Number(IMAP_PORT),
      secure: IMAP_SECURE === 'true',
      auth: { user: email, pass: password },
      logger: false
    });

    await client.connect();
    await client.logout();

    req.session.user = { email };
    res.cookie('al_user_email', email, cookieOptionsDisplay);
return res.redirect('/dashboard');

    return res.redirect('/dashboard');
} catch (err) {
  return res.redirect('/error?msg=' + encodeURIComponent('Invalid email or password.'));
}

});

app.post('/logout', (req, res) => {
    res.clearCookie('al_user_email');
  req.session.destroy(() => res.redirect('/'));
});

// -------- Health & HEAD --------
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.head('/', (req, res) => res.status(200).end());
app.head('/dashboard', requireAuth, (req, res) => res.status(200).end());

// -------- 404 --------
app.use((req, res) => res.status(404).type('text').send('Not found'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Staff portal running on ${PORT}`));
