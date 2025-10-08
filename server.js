// ===== BOOT/CRASH BEACONS (TOP OF FILE) =====
process.on('uncaughtException', (e) => { console.error('[UNCAUGHT]', e); process.exit(1); });
process.on('unhandledRejection', (r) => { console.error('[UNHANDLED]', r); process.exit(1); });

console.log(`[BOOT] Node ${process.version} starting...`);
require('dotenv').config();                 console.log('[BOOT] dotenv loaded');

// ----- requires (keep exactly one of each) -----
const path = require('path');               console.log('[BOOT] path loaded');
const express = require('express');         console.log('[BOOT] express loaded');
const session = require('express-session'); console.log('[BOOT] session loaded');
const rateLimit = require('express-rate-limit'); console.log('[BOOT] rate-limit loaded');
const Busboy = require('busboy');           console.log('[BOOT] busboy loaded');
const { MongoClient, ObjectId, GridFSBucket } = require('mongodb'); console.log('[BOOT] mongodb loaded');

// DB helper + router (must exist on disk)
const { connect } = require('./server/db'); console.log('[BOOT] db helper loaded');
const commonFiles = require('./server/routes/commonFiles'); console.log('[BOOT] commonFiles router loaded');

// ----- app + parsers -----
const app = express();

// === Email (SMTP) setup: Hostinger via env vars ===
const nodemailer = require('nodemailer');

const smtpTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,                 // e.g., smtp.hostinger.com
  port: Number(process.env.SMTP_PORT || 465),  // 465 for SSL, 587 for STARTTLS
  secure: String(process.env.SMTP_SECURE || 'true') === 'true',
  auth: {
    user: process.env.SMTP_USER,               // licensing@asian-loop.com
    pass: process.env.SMTP_PASS                // (Heroku config var)
  }
});

// Optional: print once at boot so you know SMTP is reachable
smtpTransporter.verify((err) => {
  if (err) {
    console.error('[SMTP] verify failed:', err.message || err);
  } else {
    console.log('[SMTP] ready to send mail as', process.env.SMTP_USER);
  }
});

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
console.log('[BOOT] parsers attached');
app.use('/public', express.static(path.join(__dirname, 'public')));


// ----- quick request logger -----
app.use((req, res, next) => {
  const t0 = Date.now();
  console.log(`[REQ] ${req.method} ${req.originalUrl} referer=${req.get('referer')||'-'}`);
  res.on('finish', () => console.log(`[RES] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now()-t0}ms)`));
  next();
});

// ----- env snapshot (safe) -----
console.log('[BOOT] ENV set:', {
  PORT: !!process.env.PORT,
  MONGO_URI: !!(process.env.MONGO_URI || process.env.MONGODB_URI),
  NODE_ENV: process.env.NODE_ENV
});

// ----- connect db ONCE -----
connect()
  .then(() => console.log('[BOOT] Mongo connected (Asianloop/commonFiles)'))
  .catch(err => { console.error('[BOOT] Mongo connect error:', err); process.exit(1); });

// ----- env config you had -----
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
const { MONGO_URI = '' } = process.env;

const allowlist = ALLOWLIST.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const cookieOptionsDisplay = {
  sameSite: 'lax',
  secure: true,
  httpOnly: false,
  maxAge: 60 * 60 * 1000
};

// ----- auth helpers -----
function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  return res.redirect('/');
}
const maybeRequireAuth = (typeof requireAuth === 'function')
  ? requireAuth
  : (req, res, next) => next();

// ----- session (attach ONCE, before routes that use req.session) -----
app.use(session({
  name: SESSION_NAME,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: SESSION_SECURE === 'true' }
}));
console.log('[BOOT] session middleware attached');

// ===== STATIC & PAGE ROUTES (before any catch-all) =====
console.log('[BOOT] mount /public static');


console.log('[BOOT] register /files.html');
app.get('/files.html', maybeRequireAuth, (req, res) => {
  console.log('[HIT] /files.html handler');
  res.sendFile(path.join(__dirname, 'public', 'files.html'));
});

// ===== API ROUTES =====
console.log('[BOOT] mount /api/commonFiles');
app.use('/api', (req, _res, next) => { console.log(`[HIT] API ${req.method} ${req.originalUrl}`); next(); }, commonFiles);


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

// serve /public assets (CSS/JS/images)
app.use('/public', maybeRequireAuth, express.static(path.join(__dirname, 'public')));


// Root assets
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'favicon.ico')));



// -------- Mongo (Atlas) --------


let db, gfs;
(async function connectMongo(){
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  db = client.db();
  gfs = new GridFSBucket(db, { bucketName: 'msbsFiles' });
  await db.collection('msbs_cal_events').createIndex({ start: 1 });
await db.collection('msbs_cal_events').createIndex({ end: 1 });
await db.collection('msbs_cal_events').createIndex({ staffEmail: 1 });

  console.log('Mongo connected • db:', db.databaseName);
})();


// -------- MBS: API (read-only) --------

// Announcements (public view)
app.get('/api/msbs/announcements', requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not ready' });
  try {
    const now = new Date();
    const items = await db.collection('msbs_announcements')
 .find({
  $and: [
    { $or: [ { startsAt: { $exists: false } }, { startsAt: { $lte: now } } ] },
    { $or: [ { endsAt: { $exists: false } }, { endsAt: { $gte: now } } ] }
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
      .find({}, { projection: { title: 1, kind: 1, ext: 1, bytes: 1, fileId: 1, filename: 1, url: 1 } })
      .sort({ title: 1 })
      .toArray();

    // Normalize to an href:
    // priority = GridFS by id -> GridFS by filename -> raw URL -> '#'
    const normalized = items.map(x => {
      const byId = x.fileId ? `/files/${String(x.fileId)}` : null;
      const byName = x.filename ? `/files/name/${encodeURIComponent(x.filename)}` : null;
      const raw = x.url || null;
      return {
        title: x.title,
        kind: x.kind,
        href: byId || byName || raw || '#'
      };
    });

    res.json(normalized);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// -------- MBS: Events (public view with joined internal status) --------
app.get('/api/msbs/events', requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not ready' });
  try {
    const now = new Date();
const evRows = await db.collection('msbs_events').find(
  { startDate: { $gte: now } },   // upcoming only
  { projection: { name:1, startDate:1, endDate:1, city:1, country:1, url:1, updatedAt:1 } }
).sort({ startDate: 1, name: 1 }).limit(400).toArray();


    // map internal tracker by (name, year)
    const confRows = await db.collection('msbs_conferences')
      .find({}, { projection: { eventName:1, year:1, status:1 } })
      .toArray();
    const confByKey = new Map(confRows.map(r => [`${r.eventName}::${r.year}`, r.status || 'Target']));

    const items = evRows.map(e => {
      const start = e.startDate ? new Date(e.startDate) : null;
      const end   = e.endDate ? new Date(e.endDate) : null;
      const year = (start || end || now).getUTCFullYear();
      const key = `${String(e.name||'').trim()}::${year}`;
      const status = confByKey.get(key) || 'Target';

      return {
        name: e.name,
        dates: (start && end) ? `${start.toLocaleDateString()} – ${end.toLocaleDateString()}` : (start ? start.toLocaleDateString() : ''),
        location: [e.city, e.country].filter(Boolean).join(', '),
        status,
        url: e.url || '#'
      };
    });

    res.json({ refreshedAt: now.toISOString(), items });
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


// Stream GridFS file by filename (tries msbsFiles, then fs bucket)
app.get('/files/name/:filename', requireAuth, async (req, res) => {
  if (!db) return res.status(503).type('text').send('DB not ready');
  const { filename } = req.params;

  try {
    const bucketNames = ['msbsFiles', 'fs']; // try our bucket first, then default
    for (const bucketName of bucketNames) {
      try {
        const bucket = new GridFSBucket(db, { bucketName });
        // Probe metadata to set headers nicely
        const fileDoc = await db.collection(`${bucketName}.files`).findOne({ filename });
        if (!fileDoc) throw new Error('not-here');
        if (fileDoc.contentType) res.set('Content-Type', fileDoc.contentType);
        res.set('Content-Disposition', `inline; filename="${fileDoc.filename}"`);
        return bucket.openDownloadStreamByName(filename)
          .on('error', () => res.status(404).end())
          .pipe(res);
      } catch (_) {
        // try next bucket
      }
    }
    return res.status(404).type('text').send('File not found');
  } catch (e) {
    return res.status(500).type('text').send('Error');
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


// -------- MBS: Conferences (internal tracker) --------

// GET: merged events + internal tracker
app.get('/api/msbs/conferences', requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not ready' });
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30*24*60*60*1000);

    // 1) Base events (future + last 30d)
    const evRows = await db.collection('msbs_events')
      .find({
        $or: [
          { startDate: { $gte: thirtyDaysAgo } },
          { endDate:   { $gte: thirtyDaysAgo } }
        ]
      }, {
        projection: { name:1, startDate:1, endDate:1, city:1, country:1, url:1, updatedAt:1 }
      })
      .sort({ startDate: 1, name: 1 })
      .limit(300)
      .toArray();

    // 2) Internal tracker
    const confRows = await db.collection('msbs_conferences')
      .find({}, { projection: { eventName:1, year:1, status:1, ownerEmail:1, checklist:1, notes:1, updatedAt:1 } })
      .toArray();

    // 3) Merge by (name, year)
    const key = (name, d) => `${String(name||'').trim()}::${(d ? new Date(d) : now).getUTCFullYear()}`;
    const confByKey = new Map(confRows.map(r => [ `${r.eventName}::${r.year}`, r ]));

    const items = evRows.map(e => {
      const k = key(e.name, e.startDate || e.endDate);
      const r = confByKey.get(k);
      const dates = (e.startDate && e.endDate)
        ? `${new Date(e.startDate).toLocaleDateString()} – ${new Date(e.endDate).toLocaleDateString()}`
        : (e.startDate ? new Date(e.startDate).toLocaleDateString() : '');
      return {
        name: e.name,
        year: (e.startDate ? new Date(e.startDate).getUTCFullYear()
              : (e.endDate ? new Date(e.endDate).getUTCFullYear() : new Date().getUTCFullYear())),
        dates,
        location: [e.city, e.country].filter(Boolean).join(', '),
        url: e.url || '#',
        // internal overlay (may be undefined)
        status: r?.status || 'Target',
        ownerEmail: r?.ownerEmail || '',
        checklist: {
          onePager: !!r?.checklist?.onePager,
          banner: !!r?.checklist?.banner,
          slides: !!r?.checklist?.slides,
          video: !!r?.checklist?.video,
          qr: !!r?.checklist?.qr
        },
        notes: r?.notes || ''
      };
    });

    res.json({ refreshedAt: now.toISOString(), items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST: upsert a single conference row keyed by (name, year)
app.post('/api/msbs/conferences/upsert', requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not ready' });
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const year = Number(body.year || new Date().getUTCFullYear());
    if (!name || !Number.isFinite(year)) {
      return res.status(400).json({ error: 'Missing or invalid name/year' });
    }

    const validStatus = new Set(['Target','Applied','Confirmed','Not attending']);
    const update = {
      eventName: name,
      year,
      updatedAt: new Date()
    };

    if (body.status && validStatus.has(body.status)) update.status = body.status;
    if (typeof body.ownerEmail === 'string') update.ownerEmail = body.ownerEmail.trim();

    // checklist normalization
    const cl = body.checklist || {};
    update.checklist = {
      onePager: !!cl.onePager,
      banner: !!cl.banner,
      slides: !!cl.slides,
      video: !!cl.video,
      qr: !!cl.qr
    };

    if (typeof body.notes === 'string') update.notes = body.notes.trim().slice(0, 2000);

    await db.collection('msbs_conferences').updateOne(
      { eventName: name, year },
      { $set: update, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST: manually add a new event into msbs_events (internal helper)
app.post('/api/msbs/events/add', requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not ready' });
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const city = String(b.city || '').trim();
    const country = String(b.country || '').trim();
    const url = String(b.url || '').trim();
    const startDate = b.startDate ? new Date(b.startDate) : null;
    const endDate   = b.endDate ? new Date(b.endDate) : null;
    if (!name || !startDate) return res.status(400).json({ error: 'Missing name or startDate' });

    const year = (startDate || endDate || new Date()).getUTCFullYear();
    await db.collection('msbs_events').updateOne(
      { name, year },
      { $set: { name, startDate, endDate, city, country, url, source: 'manual', updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -------- MBS: Notes --------
app.get('/api/msbs/notes', requireAuth, async (req, res) => {
  try {
    const rows = await db.collection('msbs_notes')
      .find({}, { projection: { _id:1, title:1, due:1, ownerEmail:1, picStaff:1, status:1, createdAt:1, /* add: */ remarks:1 } })

      .sort({ due: 1 })
      .toArray();

    // Ensure _id is a string for the frontend
    const notes = rows.map(n => ({ ...n, _id: String(n._id) }));
    res.json(notes);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.post('/api/msbs/notes/upsert', requireAuth, async (req, res) => {
  try {
    const me = req.session?.user?.email || '';
    const b = req.body || {};
    const now = new Date();

    // EDIT by id (owner only) — can change title, due, picStaff, status
    if (b.id) {
      const _id = new ObjectId(b.id);
      const note = await db.collection('msbs_notes').findOne({ _id });
      if (!note) return res.status(404).json({ error: 'Not found' });
      if (note.ownerEmail !== me) return res.status(403).json({ error: 'Not your note' });

      const update = { updatedAt: now };
      if (typeof b.title === 'string')   update.title    = b.title.trim();
      if (b.due)                         update.due      = new Date(b.due);
      if (typeof b.picStaff === 'string')update.picStaff = b.picStaff.trim();
      if (typeof b.status === 'string' && ['Open','Close','Overdue','Urgent','Completed','Info'].includes(b.status))
        update.status = b.status;
      if (typeof b.remarks === 'string') update.remarks = b.remarks.trim().slice(0, 1000);

      await db.collection('msbs_notes').updateOne({ _id }, { $set: update });
      return res.json({ ok: true, updated: true });
    }

    // CREATE (owner = current user)
    const title = String(b.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Missing title' });

    await db.collection('msbs_notes').insertOne({
      title,
      due: b.due ? new Date(b.due) : null,
      ownerEmail: me,
      picStaff: (b.picStaff || '').trim(),
      status: 'Open',
      createdAt: now,
      updatedAt: now,
      remarks: (typeof b.remarks === 'string' ? b.remarks.trim().slice(0, 1000) : null)
    });
    res.json({ ok: true, created: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.post('/api/msbs/notes/delete', requireAuth, async (req, res) => {
  try {
    const me = req.session?.user?.email || '';
    const _id = new ObjectId(req.body.id);
    const note = await db.collection('msbs_notes').findOne({ _id });
    if (!note) return res.status(404).json({ error: 'Not found' });
    if (note.ownerEmail !== me) return res.status(403).json({ error: 'Not your note' });

    await db.collection('msbs_notes').deleteOne({ _id });
    res.json({ ok: true, deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});



// -------- MBS: File hub --------
// List files (optional folder filter)
app.get('/api/msbs/files', requireAuth, async (req, res) => {
  try {
    const q = {};
    if (req.query.folder) q['metadata.folder'] = String(req.query.folder).trim();

    const rows = await db.collection('msbsFiles.files')
      .find(q)
      .project({
        filename: 1,
        length: 1,
        uploadDate: 1,
        contentType: 1,
        'metadata.folder': 1,
        'metadata.ownerEmail': 1,
        'metadata.branding': 1
      })
      .sort({ uploadDate: -1 })
      .toArray();

    const items = rows.map(f => ({
      id: String(f._id),
      name: f.filename,
      size: f.length,
      uploaded: f.uploadDate,
      contentType: f.contentType || '',
      folder: f?.metadata?.folder || '',
      ownerEmail: f?.metadata?.ownerEmail || '',
      branding: !!(f?.metadata?.branding)
    }));

    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// ===== MBS: Files Hub (GridFS) =====

// List files (optional folder filter)
app.get('/api/msbs/files', requireAuth, async (req, res) => {
  try {
    const q = {};
    if (req.query.folder) q['metadata.folder'] = String(req.query.folder).trim();

    const rows = await db.collection('msbsFiles.files')
      .find(q)
      .project({
        filename: 1,
        length: 1,
        uploadDate: 1,
        contentType: 1,
        'metadata.folder': 1,
        'metadata.ownerEmail': 1,
        'metadata.branding': 1
      })
      .sort({ uploadDate: -1 })
      .toArray();

    const items = rows.map(f => ({
      id: String(f._id),
      name: f.filename,
      size: f.length,
      uploaded: f.uploadDate,
      contentType: f.contentType || '',
      folder: f?.metadata?.folder || '',
      ownerEmail: f?.metadata?.ownerEmail || '',
      branding: !!(f?.metadata?.branding)
    }));
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Distinct folders
app.get('/api/msbs/files/folders', requireAuth, async (req, res) => {
  try {
    const folders = await db.collection('msbsFiles.files').distinct('metadata.folder');
    res.json((folders || []).filter(Boolean).sort());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload (multi-file). Owner = current user. Optional folder + branding flag.
app.post('/api/msbs/files/upload', requireAuth, (req, res) => {
  if (!gfs && db) gfs = new GridFSBucket(db, { bucketName: 'msbsFiles' });
  if (!db || !gfs) return res.status(503).json({ error: 'DB not ready' });

  const ownerEmail = req.session?.user?.email || '';
  const bb = Busboy({ headers: req.headers });

  // Prefer query values (works even if fields stream after files)
  let folder = String(req.query.folder || '').trim();
  let brandingFlag = /^(1|true|on)$/i.test(String(req.query.branding || '').trim());

  let pending = 0, finished = false, responded = false;
  const uploaded = [];

  const reply = (ok, payload) => {
    if (responded) return;
    responded = true;
    return ok ? res.json({ ok: true, uploaded })
              : res.status(500).json(payload || { error: 'Upload failed' });
  };
  const maybeReply = () => {
    if (finished && pending === 0 && !responded) reply(true);
  };

  // If the form field arrives later, only override if still blank/false
  bb.on('field', (name, val) => {
    if (name === 'folder' && !folder) folder = String(val || '').trim();
    if (name === 'branding' && !brandingFlag) brandingFlag = /^(1|true|on)$/i.test(String(val || '').trim());
  });

  bb.on('file', (_name, file, info) => {
    const { filename, mimeType } = info || {};
    if (!filename) return;
    pending++;

    const up = gfs.openUploadStream(filename, {
      contentType: mimeType || undefined,
      metadata: { folder, ownerEmail, branding: brandingFlag }
    });

    file.pipe(up)
      .on('error', err => reply(false, { error: err.message }))
      .on('finish', async () => {
        uploaded.push({ id: String(up.id), name: up.filename });

        // If marked as branding, upsert into msbs_brand_assets
        if (brandingFlag) {
          try {
            const fn = up.filename || '';
            const ext = (fn.split('.').pop() || '').toLowerCase();
            const kind =
              /pptx?/.test(ext) ? 'slides' :
              /docx?/.test(ext) ? 'letterhead' :
              /pdf/.test(ext)   ? 'brochure' :
              /png|jpe?g|svg|ico/.test(ext) ? 'logo' : 'asset';

            await db.collection('msbs_brand_assets').updateOne(
              { fileId: up.id },
              { $set: { title: fn, kind, ext, fileId: up.id, bytes: null, createdAt: new Date() } },
              { upsert: true }
            );
          } catch (e) {
            // Don't fail the whole upload because branding upsert failed
            console.warn('Branding upsert failed:', e.message);
          }
        }

        pending--;
        maybeReply();
      });
  });

  bb.on('finish', () => { finished = true; maybeReply(); });

  req.pipe(bb);
});

// Mark/Unmark branding on an existing file (owner-only)
app.post('/api/msbs/files/branding', requireAuth, async (req, res) => {
  try {
    const me = (req.session?.user?.email || '').toLowerCase();
    const { id, on, title } = req.body || {};
    const _id = new ObjectId(String(id));

    const f = await db.collection('msbsFiles.files').findOne({ _id });
    if (!f) return res.status(404).json({ error: 'Not found' });

    const owner = (f?.metadata?.ownerEmail || '').toLowerCase();
    if (owner && owner !== me) return res.status(403).json({ error: 'Not your file' });

    // Update file metadata flag
    await db.collection('msbsFiles.files').updateOne(
      { _id },
      { $set: { 'metadata.branding': !!on } }
    );

    if (on) {
      const fn = f.filename || '';
      const ext = (fn.split('.').pop() || '').toLowerCase();
      const kind =
        /pptx?/.test(ext) ? 'slides' :
        /docx?/.test(ext) ? 'letterhead' :
        /pdf/.test(ext)   ? 'brochure' :
        /png|jpe?g|svg|ico/.test(ext) ? 'logo' : 'asset';

      await db.collection('msbs_brand_assets').updateOne(
        { fileId: _id },
        { $set: { title: (title || fn), kind, ext, fileId: _id, bytes: null, createdAt: new Date() } },
        { upsert: true }
      );
    } else {
      await db.collection('msbs_brand_assets').deleteOne({ fileId: _id });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});







// Delete (owner only)
app.delete('/api/msbs/files/:id', requireAuth, async (req, res) => {
  try {
    const _id = new ObjectId(req.params.id);
    const me = (req.session?.user?.email || '').toLowerCase();
    const doc = await db.collection('msbsFiles.files').findOne({ _id });
    if (!doc) return res.status(404).json({ error: 'Not found' });

    const owner = (doc?.metadata?.ownerEmail || '').toLowerCase();
    const isOwnerless = !owner;
    if (!isOwnerless && owner !== me) return res.status(403).json({ error: 'Not your file' });

    await gfs.delete(_id);
    res.json({ ok: true, deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mark/Unmark branding on an existing file (owner-only)
app.post('/api/msbs/files/branding', requireAuth, async (req, res) => {
  try {
    const me = (req.session?.user?.email || '').toLowerCase();
    const { id, on, title } = req.body || {};
    const _id = new ObjectId(String(id));
    const f = await db.collection('msbsFiles.files').findOne({ _id });
    if (!f) return res.status(404).json({ error: 'Not found' });

    const owner = (f?.metadata?.ownerEmail || '').toLowerCase();
    if (owner && owner !== me) return res.status(403).json({ error: 'Not your file' });

    // Update file metadata flag
    await db.collection('msbsFiles.files').updateOne(
      { _id },
      { $set: { 'metadata.branding': !!on } }
    );

    if (on) {
      const fn = f.filename || '';
      const ext = (fn.split('.').pop() || '').toLowerCase();
      const kind = /pptx?/.test(ext) ? 'slides' :
                   /docx?/.test(ext) ? 'letterhead' :
                   /pdf/.test(ext)   ? 'brochure' :
                   /png|jpg|jpeg|svg|ico/.test(ext) ? 'logo' : 'asset';

      await db.collection('msbs_brand_assets').updateOne(
        { fileId: _id },
        {
          $set: {
            title: (title || fn),
            kind, ext,
            fileId: _id,
            bytes: null,
            createdAt: new Date()
          }
        },
        { upsert: true }
      );
    } else {
      await db.collection('msbs_brand_assets').deleteOne({ fileId: _id });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -------- MBS: Team Calendar (CRUD) --------
const CAL_TYPES = ['WFH','Onsite','Travel','Leave','Conf','Meeting'];

// Optional admin override (comma-separated emails). If unset, only owners can edit/delete.
const ADMIN_LIST = String(process.env.MSBS_ADMIN_EMAILS || '')
  .toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
const isAdmin = (email) => email && ADMIN_LIST.includes(String(email).toLowerCase());

function sanitizeCalInput(body){
  const type = String(body.type || '').trim();
  if (!CAL_TYPES.includes(type)) throw new Error('Invalid type');

  const start = new Date(body.start);
  const end   = new Date(body.end);
  if (!(start instanceof Date) || isNaN(+start)) throw new Error('Invalid start');
  if (!(end instanceof Date)   || isNaN(+end))   throw new Error('Invalid end');
  if (end < start) throw new Error('End before start');

  return {
    type,
    start,
    end,
    allday: !!body.allday,
    location: String(body.location || '').trim().slice(0,64),
    note: String(body.note || '').trim().slice(0,140),
    title: String(body.title || '').trim().slice(0,60)
  };
}

// List events overlapping a range
app.get('/api/msbs/cal/events', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'DB not ready' });
    const start = new Date(req.query.start);
    const end   = new Date(req.query.end);
    if (isNaN(+start) || isNaN(+end)) return res.status(400).send('Invalid range');

    const rows = await db.collection('msbs_cal_events')
      .find({ $and: [ { start: { $lte: end } }, { end: { $gte: start } } ] })
      .sort({ start: 1 })
      .toArray();

    res.json(rows.map(d => ({
      _id: String(d._id),
      staffEmail: d.staffEmail,
      staffName: d.staffName || '',
      type: d.type,
      location: d.location || '',
      start: d.start,
      end: d.end,
      allday: !!d.allday,
      note: d.note || '',
      title: d.title || ''
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create (owner = logged-in user)
app.post('/api/msbs/cal/events', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'DB not ready' });
    const me = req.session?.user?.email || '';
    if (!me) return res.status(401).send('Auth required');

    const input = sanitizeCalInput(req.body || {});
    const now = new Date();
    const doc = {
      staffEmail: String(me),
      staffName: '', // your login creates session with { email } only
      ...input,
      createdAt: now,
      updatedAt: now
    };
    const r = await db.collection('msbs_cal_events').insertOne(doc);
    res.json({ ok: true, _id: String(r.insertedId) });
  } catch (e) {
    res.status(400).send(e.message || 'Bad request');
  }
});

// Update (owner or admin)
app.patch('/api/msbs/cal/events/:id', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'DB not ready' });
    const me = (req.session?.user?.email || '').toLowerCase();
    if (!me) return res.status(401).send('Auth required');

    const id = new ObjectId(req.params.id);
    const input = sanitizeCalInput(req.body || {});
    const col = db.collection('msbs_cal_events');
    const doc = await col.findOne({ _id: id });
    if (!doc) return res.status(404).send('Not found');

    const owner = String(doc.staffEmail || '').toLowerCase();
    if (owner !== me && !isAdmin(me)) return res.status(403).send('Not allowed');

    await col.updateOne({ _id: id }, { $set: { ...input, updatedAt: new Date() } });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).send(e.message || 'Bad request');
  }
});

// Delete (owner or admin)
app.delete('/api/msbs/cal/events/:id', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'DB not ready' });
    const me = (req.session?.user?.email || '').toLowerCase();
    if (!me) return res.status(401).send('Auth required');

    const id = new ObjectId(req.params.id);
    const col = db.collection('msbs_cal_events');
    const doc = await col.findOne({ _id: id });
    if (!doc) return res.status(404).send('Not found');

    const owner = String(doc.staffEmail || '').toLowerCase();
    if (owner !== me && !isAdmin(me)) return res.status(403).send('Not allowed');

    await col.deleteOne({ _id: id });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).send(e.message || 'Bad request');
  }
});


// -------- 404 --------
app.use((req, res) => res.status(404).type('text').send('Not found'));

const PORT = process.env.PORT || 3000;


// === Test email route (manual trigger from admin.html) ===
// GET /api/email/test → sends a test email to ADMIN_NOTIFY_EMAIL
app.get('/api/email/test', async (req, res) => {
  try {
    const to = process.env.ADMIN_NOTIFY_EMAIL || 'mzmohamed@asian-loop.com';
    const info = await smtpTransporter.sendMail({
      from: process.env.SMTP_FROM || 'Licensing <licensing@asian-loop.com>',
      to,
      subject: '✅ Asianloop admin email test',
      text: 'This is a test email from server.js using Hostinger SMTP. If you received this, SMTP is fully working.',
    });
    console.log('[SMTP] sent:', info.messageId);
    res.status(200).json({ ok: true, messageId: info.messageId, to });
  } catch (err) {
    console.error('[SMTP] send error:', err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});



app.listen(PORT, () => console.log(`Staff portal running on ${PORT}`));
