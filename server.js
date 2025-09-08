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
    const notes = await db.collection('msbs_notes')
      .find({}, { projection: { _id:1, title:1, due:1, ownerEmail:1, picStaff:1, status:1, createdAt:1 } })
      .sort({ due: 1 })
      .toArray();
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
      updatedAt: now
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
app.get('/api/msbs/files', requireAuth, async (req,res)=>{
  if (!db) return res.status(503).json({error:'DB not ready'});
  try{
    const files = await db.collection('msbsFiles.files')
      .find({}, {projection:{filename:1,length:1,uploadDate:1}})
      .sort({uploadDate:-1}).toArray();
    res.json(files.map(f=>({
      id:f._id, name:f.filename, size:f.length, uploaded:f.uploadDate
    })));
  }catch(e){res.status(500).json({error:e.message});}
});


// -------- 404 --------
app.use((req, res) => res.status(404).type('text').send('Not found'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Staff portal running on ${PORT}`));
