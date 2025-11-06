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
const multer = require('multer');

// DB helper + router (must exist on disk)
const { connect } = require('./server/db'); console.log('[BOOT] db helper loaded');
const commonFiles = require('./server/routes/commonFiles'); console.log('[BOOT] commonFiles router loaded');
const crypto = require('crypto');

// ----- app + parsers -----
const app = express();
// === Email (SMTP) setup: Hostinger via env vars ===
const nodemailer = require('nodemailer');

const smtpTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,                 // smtp.hostinger.com
  port: Number(process.env.SMTP_PORT || 465),  // 465 SSL or 587 STARTTLS
  secure: String(process.env.SMTP_SECURE || 'true') === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

smtpTransporter.verify((err) => {
  if (err) console.error('[SMTP] verify failed:', err.message || err);
  else console.log('[SMTP] ready to send mail as', process.env.SMTP_USER);
});






app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
console.log('[BOOT] parsers attached');

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


// helper used by test-reminder route and cron
// helper used by test-reminder route and cron
async function sendLicenseReminderEmail(lic, { test=false, toOverride=null } = {}) {
  const toRaw = (toOverride || process.env.ADMIN_NOTIFY_EMAIL || 'mzmohamed@asian-loop.com');
  const toList = String(toRaw).split(/[;,]/).map(s => s.trim()).filter(Boolean);

  const name = lic.name || '(unnamed)';
  const vendor = lic.vendor || '-';
  const type = lic.type || '-';
  const start = lic.startAt ? new Date(lic.startAt).toISOString().slice(0,10) : '-';
  const end = lic.endAt ? new Date(lic.endAt).toISOString().slice(0,10) : '-';

  const subject = test
    ? `TEST: 60-day license reminder — ${name}`
    : `60-day license reminder — ${name}`;
  const text = [
    test ? '[TEST EMAIL — triggered manually]' : '',
    `License: ${name}`,
    `Type: ${type}`,
    `Vendor: ${vendor}`,
    `Start: ${start}`,
    `Expiry: ${end}`,
    '',
    `Notes: ${lic.notes || '-'}`,
  ].join('\n');

  const info = await smtpTransporter.sendMail({
    from: process.env.SMTP_FROM || 'Licensing <licensing@asian-loop.com>',
    to: toList,   // 👈 supports multiple recipients
    subject,
    text
  });

  // Helpful server log to see who actually received it
  console.log('[MAIL] accepted:', info.accepted, 'rejected:', info.rejected);
}




/* ======================= Bank Accounts API (encrypted) ======================= */
// Requires: const { MongoClient, ObjectId, GridFSBucket } = require('mongodb');
//           const crypto = require('crypto');  <-- add at the top of file if not present


let __mongoClientBank = null;
async function bankDb(){
  if(!__mongoClientBank){
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if(!uri) throw new Error('MONGO_URI not set');
    __mongoClientBank = new MongoClient(uri);
    await __mongoClientBank.connect();
    console.log('[BANK] Mongo connected');
  }
  return __mongoClientBank.db();
}
function bankColl(db){ return db.collection('bank_accounts'); }
function usersColl(db){ return db.collection('users'); }

// --- auth guard (keep simple: admin only; tweak as you prefer)
// Admin/Payroll guard with tier/role/email allowlist
function requireAdmin(req, res, next){
  const u = req.session?.user || null;
  if (!u) return res.status(401).send('Login required');

  const role = String(u.role || '').toLowerCase();
  const tier = String(u.tier || '').toLowerCase();
  const email = String(u.email || '').toLowerCase();

  // Allow common senior roles/titles you use
  const allowedTiers = [
    'senior manager',
    'manager',
    'senior executive',   // include if you want managers+ to test
    'executive'           // include if you want broader access; remove for stricter
  ];

  // Optional: comma/semicolon-separated allowlist of emails
  const allowListEnv = String(process.env.PAYROLL_ALLOW_EMAILS || '').toLowerCase();
  const allowEmails = allowListEnv.split(/[;,]/).map(s=>s.trim()).filter(Boolean);

  const ok =
    role === 'admin' ||
    allowedTiers.includes(tier) ||
    allowEmails.includes(email);

  if (ok) return next();

  console.warn('[BANK] 403 for user', { email, role, tier });
  return res.status(403).send('Forbidden');
}


// --- encryption helpers (AES-256-GCM)
function getKey(){
  const raw = process.env.BANK_ENC_KEY;
  if(!raw) throw new Error('BANK_ENC_KEY not set');
  const key = Buffer.from(raw, raw.startsWith('base64:') ? 'base64' : 'utf8');
  if (key.length !== 32) throw new Error('BANK_ENC_KEY must be 32 bytes');
  return key;
}
function encAccount(no){
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const out = Buffer.concat([cipher.update(no, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, out, tag]).toString('base64');
}
function decAccount(b64){
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0,12);
  const tag = buf.subarray(buf.length-16);
  const text = buf.subarray(12, buf.length-16);
  const key = getKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(text), decipher.final()]);
  return out.toString('utf8');
}
function cleanDigits(s){ return String(s||'').replace(/\D+/g,''); }

// GET /api/bank  (list; optional ?default=1|0 & ?status=archived & ?user=<id>)
app.get('/api/bank', requireAdmin, async (req,res)=>{
  try{
    const db = await bankDb();
    const q = { };
    if (req.query.status === 'archived') q.archivedAt = { $exists: true };
    else q.archivedAt = { $exists: false };
    if (req.query.default === '1') q.isDefault = true;
    if (req.query.default === '0') q.isDefault = { $ne: true };
    if (req.query.user && ObjectId.isValid(req.query.user)) q.userId = new ObjectId(req.query.user);

    // join basic user info for display:
    const items = await bankColl(db).aggregate([
      { $match: q },
      { $sort: { updatedAt: -1 } },
      { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },
      { $addFields: { user: { $first: "$user" } } },
      { $project: { accountNo_enc: 0 } }
    ]).toArray();

res.json(items.map(x=>({
  ...x,
  _id: String(x._id),
  userId: String(x.userId),
  user: x.user ? {
    _id: String(x.user._id),
    name: x.user.name,
    email: x.user.email,
    dept: x.user.dept,
    tier: (x.user.tier || x.user.role),
    staffNo: x.user.staffNo  // ← include Staff No for UI
  } : null
})));

  }catch(e){
    console.error('[BANK] list error', e);
    res.status(500).send('Error');
  }
});

// POST /api/bank  (create)
app.post('/api/bank', requireAdmin, async (req,res)=>{
  try{
    const { userId, bankName, accountName, accountNo, branch='', swift='', iban='', isDefault=false, notes='', effectiveAt='' } = req.body || {};
    if(!ObjectId.isValid(userId)) return res.status(400).send('Bad userId');
    if(!bankName || !accountName || !accountNo) return res.status(400).send('Missing required fields');

    const digits = cleanDigits(accountNo);
    if (digits.length < 8 || digits.length > 24) return res.status(400).send('Invalid account number length');

    const db = await bankDb();
    if (isDefault) await bankColl(db).updateMany({ userId: new ObjectId(userId), archivedAt: { $exists: false } }, { $set: { isDefault: false } });

    const doc = {
      userId: new ObjectId(userId),
      bankName: String(bankName).trim(),
      accountName: String(accountName).trim(),
      accountNo_enc: encAccount(digits),
      accountNo_last4: digits.slice(-4),
      branch: String(branch||'').trim(),
      swift: String(swift||'').trim(),
      iban: String(iban||'').trim(),
      isDefault: !!isDefault,
      notes: String(notes||'').trim(),
      effectiveAt: effectiveAt ? new Date(effectiveAt) : null,
      createdAt: new Date(),
      updatedAt: new Date(),
      archivedAt: null
    };
    const r = await bankColl(db).insertOne(doc);
    res.json({ ok:true, _id: String(r.insertedId) });
  }catch(e){
    console.error('[BANK] create error', e);
    res.status(500).send('Error');
  }
});

// PUT /api/bank/:id  (update; never returns full number)
app.put('/api/bank/:id', requireAdmin, async (req,res)=>{
  try{
    const id = req.params.id;
    if(!ObjectId.isValid(id)) return res.status(400).send('Bad id');
    const $set = { updatedAt: new Date() };
    ['bankName','accountName','branch','swift','iban','notes'].forEach(k=>{
      if (req.body && k in req.body) $set[k] = String(req.body[k]||'').trim();
    });
    if (req.body && 'effectiveAt' in req.body) $set.effectiveAt = req.body.effectiveAt ? new Date(req.body.effectiveAt) : null;
    if (req.body && 'isDefault' in req.body) $set.isDefault = !!(req.body.isDefault===true || req.body.isDefault==='true' || req.body.isDefault==='on');

    if (req.body && 'accountNo' in req.body && req.body.accountNo){
      const digits = cleanDigits(req.body.accountNo);
      if (digits.length < 8 || digits.length > 24) return res.status(400).send('Invalid account number length');
      $set.accountNo_enc = encAccount(digits);
      $set.accountNo_last4 = digits.slice(-4);
    }

    const db = await bankDb();
    if ($set.isDefault === true){
      const doc = await bankColl(db).findOne({ _id: new ObjectId(id) });
      if (doc) await bankColl(db).updateMany({ userId: doc.userId, archivedAt: { $exists: false } }, { $set: { isDefault: false } });
    }
    const r = await bankColl(db).updateOne({ _id: new ObjectId(id) }, { $set });
    res.json({ ok:true, modified:r.modifiedCount });
  }catch(e){
    console.error('[BANK] update error', e);
    res.status(500).send('Error');
  }
});

// PATCH /api/bank/:id/default
app.patch('/api/bank/:id', requireAdmin, async (req,res,next)=>next()); // no-op to avoid conflicts
app.patch('/api/bank/:id/default', requireAdmin, async (req,res)=>{
  try{
    const id = req.params.id;
    if(!ObjectId.isValid(id)) return res.status(400).send('Bad id');
    const db = await bankDb();
    const doc = await bankColl(db).findOne({ _id: new ObjectId(id) });
    if (!doc) return res.status(404).send('Not found');
    await bankColl(db).updateMany({ userId: doc.userId, archivedAt: { $exists: false } }, { $set: { isDefault: false } });
    await bankColl(db).updateOne({ _id: new ObjectId(id) }, { $set: { isDefault: true, updatedAt: new Date() } });
    res.json({ ok:true });
  }catch(e){
    console.error('[BANK] default error', e);
    res.status(500).send('Error');
  }
});

// DELETE /api/bank/:id  (soft delete)
app.delete('/api/bank/:id', requireAdmin, async (req,res)=>{
  try{
    const id = req.params.id;
    if(!ObjectId.isValid(id)) return res.status(400).send('Bad id');
    const db = await bankDb();
    const r = await bankColl(db).updateOne({ _id: new ObjectId(id) }, { $set: { archivedAt: new Date(), updatedAt: new Date() } });
    res.json({ ok:true, archived:r.modifiedCount });
  }catch(e){
    console.error('[BANK] delete error', e);
    res.status(500).send('Error');
  }
});

// POST /api/bank/:id/reveal  (returns full account; admin only)
app.post('/api/bank/:id/reveal', requireAdmin, async (req,res)=>{
  try{
    const id = req.params.id;
    if(!ObjectId.isValid(id)) return res.status(400).send('Bad id');
    const db = await bankDb();
    const doc = await bankColl(db).findOne({ _id: new ObjectId(id), archivedAt: { $exists: false } });
    if(!doc) return res.status(404).send('Not found');
    const full = decAccount(doc.accountNo_enc);
    console.log('[BANK] reveal', { id, userId:String(doc.userId), last4: doc.accountNo_last4 }); // audit-friendly (no full number)
    res.json({ ok:true, accountNo: full });
  }catch(e){
    console.error('[BANK] reveal error', e);
    res.status(500).send('Error');
  }
});
/* =========================================================================== */





// ===== API ROUTES =====
// ===== API ROUTES =====
// ===== API ROUTES =====

// (A) Simple standalone test endpoint — MUST be before other /api mounts
app.get('/api/email/test', async (req, res) => {
  try {
    const to = process.env.ADMIN_NOTIFY_EMAIL || 'mzmohamed@asian-loop.com';
    const info = await smtpTransporter.sendMail({
      from: process.env.SMTP_FROM || 'Licensing <licensing@asian-loop.com>',
      to,
      subject: '✅ Asianloop admin email test',
      text: 'This is a test email from server.js using Hostinger SMTP.'
    });
    console.log('[SMTP] sent:', info.messageId);
    res.status(200).json({ ok: true, messageId: info.messageId, to });
  } catch (err) {
    console.error('[SMTP] send error:', err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

/* ---------- Licensing API (MongoDB + GridFS, 5 MB cap) ----------
   IMPORTANT: We are NOT re-declaring MongoClient/ObjectId/GridFSBucket/Busboy here
   because you already require them at the top of server.js.
------------------------------------------------------------------ */

let __mongoClientLic = null;
async function licDb() {
  if (!__mongoClientLic) {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGO_URI not set');
    __mongoClientLic = new MongoClient(uri);
    await __mongoClientLic.connect();
    console.log('[LIC] Mongo connected');
  }
  return __mongoClientLic.db(); // default DB from URI
}
function licColl(db) { return db.collection('licenses'); }
function assetsColl(db){ return db.collection('assets'); }
function assetPhotosBucket(db){
  return new GridFSBucket(db, { bucketName: 'asset_photos' });
}

function announcementsColl(db){ return db.collection('announcements'); }


// GET /api/licenses
app.get('/api/licenses', async (_req, res) => {
  try {
    const db = await licDb();
    const items = await licColl(db).find({}).sort({ endAt: 1 }).toArray();
    res.json(items.map(x => ({ ...x, _id: String(x._id) })));
  } catch (e) {
    console.error('[LIC] list error', e);
    res.status(500).json({ ok: false, error: 'Failed to load licenses' });
  }
});

// POST /api/licenses
// POST /api/licenses
app.post('/api/licenses', async (req, res) => {
  try {
    const b = req.body || {};
    const { name, type, vendor, seats, startAt, endAt, notes } = b;

    // Required fields
    if (!name || !type || !startAt || !endAt) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }

    // Coerce and sanitize
    const doc = {
      name: String(name).trim(),
      type: String(type).trim(),
      vendor: String(vendor || '').trim(),
      seats: Number.isFinite(+seats) ? +seats : 0,
      startAt: new Date(startAt),
      endAt: new Date(endAt),
      notes: String(notes || '').trim(),
      notify7d: !!(
        b.notify7d === true ||
        b.notify7d === 'true' ||
        b.notify7d === 'on' ||
        b.notify7d === 1 ||
        b.notify7d === '1'
      ),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const db = await licDb();
    const r = await licColl(db).insertOne(doc);
    return res.json({ ok: true, _id: String(r.insertedId) });
  } catch (e) {
    console.error('[LIC] create error', e);
    return res.status(500).json({ ok: false, error: 'Create failed' });
  }
});


// PUT /api/licenses/:id
// PUT /api/licenses/:id
app.put('/api/licenses/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ ok:false, error:'Bad id' });
    }

    const { name, type, vendor, seats, startAt, endAt, notes } = req.body || {};
    const $set = { updatedAt: new Date() };

    if (name !== undefined)   $set.name   = String(name).trim();
    if (type !== undefined)   $set.type   = String(type).trim();
    if (vendor !== undefined) $set.vendor = String(vendor).trim();
    if (seats !== undefined)  $set.seats  = Number(seats || 0);
    if (startAt)              $set.startAt = new Date(startAt);
    if (endAt)                $set.endAt   = new Date(endAt);
    if (notes !== undefined)  $set.notes  = String(notes).trim();

    // ✅ handle the checkbox/boolean inside the try and before updateOne
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'notify7d')) {
      $set.notify7d = !!(
        req.body.notify7d === true ||
        req.body.notify7d === 'true' ||
        req.body.notify7d === 'on'   ||
        req.body.notify7d === 1      ||
        req.body.notify7d === '1'
      );
    }

    const db = await licDb();
    const r = await licColl(db).updateOne({ _id: new ObjectId(id) }, { $set });
    return res.json({ ok: true, matched: r.matchedCount, modified: r.modifiedCount });
  } catch (e) {
    console.error('[LIC] update error', e);
    return res.status(500).json({ ok:false, error:'Update failed' });
  }
});





// DELETE /api/licenses/:id
app.delete('/api/licenses/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ ok:false, error:'Bad id' });

    const db = await licDb();
    // delete proof if exists
    const doc = await licColl(db).findOne({ _id: new ObjectId(id) });
    if (doc?.proofFileId) {
      try {
        const bucket = new GridFSBucket(db);
        await bucket.delete(new ObjectId(doc.proofFileId));
      } catch (e) { console.warn('[LIC] delete file warn', e.message); }
    }
    const r = await licColl(db).deleteOne({ _id: new ObjectId(id) });
    res.json({ ok:true, deleted: r.deletedCount });
  } catch (e) {
    console.error('[LIC] delete error', e);
    res.status(500).json({ ok:false, error:'Delete failed' });
  }
});

// POST /api/licenses/:id/upload  (GridFS, 5 MB limit)
app.post('/api/licenses/:id/upload', async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ ok:false, error:'Bad id' });

    const db = await licDb();
    const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 5 * 1024 * 1024 } });
    let hadFile = false;

    bb.on('file', (_name, file, info) => {
      hadFile = true;
      const filename = info?.filename || 'proof';
      const bucket = new GridFSBucket(db);
      const up = bucket.openUploadStream(filename, {
        metadata: { type: 'license-proof', licenseId: id, filename }
      });

      file.on('limit', () => {
        file.unpipe(up);
        up.destroy(new Error('File too large (max 5 MB)'));
      });

      file.pipe(up)
        .on('error', (err) => {
          console.error('[LIC] gridfs upload error', err);
          if (!res.headersSent) res.status(400).json({ ok:false, error: err.message || 'Upload error' });
        })
        .on('finish', async () => {
          await licColl(db).updateOne(
            { _id: new ObjectId(id) },
            { $set: { proofFileId: up.id, updatedAt: new Date() } }
          );
          if (!res.headersSent) res.json({ ok:true, fileId: String(up.id) });
        });
    });

    bb.on('finish', () => {
      if (!hadFile && !res.headersSent) res.status(400).json({ ok:false, error:'No file' });
    });

    req.pipe(bb);
  } catch (e) {
    console.error('[LIC] upload error', e);
    res.status(500).json({ ok:false, error:'Upload failed' });
  }
});

// GET /api/licensefile/:id  (serve GridFS file)
app.get('/api/licensefile/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).send('Bad id');
    const db = await licDb();
    const bucket = new GridFSBucket(db);
    const dl = bucket.openDownloadStream(new ObjectId(id));
    dl.on('file', (f) => {
      res.setHeader('Content-Type', f.contentType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${(f.filename||'file').replace(/"/g,'')}"`);
    });
    dl.on('error', () => res.status(404).send('Not found'));
    dl.pipe(res);
  } catch (e) {
    console.error('[LIC] file serve error', e);
    res.status(500).send('Error');
  }
});


// POST /api/licenses/:id/test-reminder  — send an immediate email for testing
app.post('/api/licenses/:id/test-reminder', async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).send('Bad id');
    const db = await licDb();
    const lic = await licColl(db).findOne({ _id: new ObjectId(id) });
    if (!lic) return res.status(404).send('Not found');

    // allow ?to=email@example.com or JSON body {to:"..."}
    const toOverride = req.query.to || (req.body && req.body.to) || null;

    await sendLicenseReminderEmail(lic, { test: true, toOverride });
    res.json({ ok: true });
  } catch (e) {
    console.error('[LIC] test-reminder error', e);
    res.status(500).send('Error sending test');
  }
});


/* ------------------ Staff Directory API (safe CRUD) ------------------ */
// NOTE: uses same Mongo driver already required at top; no re-declare.
let __mongoClientStaff = null;
async function staffDb() {
  if (!__mongoClientStaff) {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGO_URI not set');
    __mongoClientStaff = new MongoClient(uri);
    await __mongoClientStaff.connect();
    console.log('[STAFF] Mongo connected');
  }
  return __mongoClientStaff.db();
}
function staffColl(db){ return db.collection('users'); } // <-- using your existing users collection

// GET /api/staff  (list non-archived)
app.get('/api/staff', async (_req, res) => {
  try{
    const db = await staffDb();
    const items = await staffColl(db)
      .find({ archivedAt: { $exists: false } })
.project({
  name:1, email:1, personalEmail:1,
  dept:1, tier:1, role:1, position:1,
  status:1, lastLoginAt:1, mfaEnabled:1, notes:1,
  staffNo:1, address:1, idNo:1, passportNo:1, hireDate:1,
  carReg:1, carDesc:1,
  nokName:1, nokRelation:1, nokPhone:1, emergencyNotes:1,
  family:1,
  createdAt:1, updatedAt:1
})


      .sort({ name: 1 })
      .toArray();
    res.json(items.map(x => ({ ...x, _id: String(x._id) })));
  }catch(e){
    console.error('[STAFF] list error', e);
    res.status(500).json({ ok:false, error:'Failed to load staff' });
  }
});

// POST /api/staff  (create)
app.post('/api/staff', async (req, res) => {
  try{
   const { name, email, personalEmail='', dept='', tier='Executive', position='', status='Active', mfaEnabled=false, notes='' } = req.body || {};

const allowed = (process.env.ALLOWED_DOMAIN || '@asian-loop.com').toLowerCase();
if(!String(email).toLowerCase().endsWith(allowed)) return res.status(400).send(`Email must end with ${allowed}`);

const doc = {
  name: String(name).trim(),
  email: String(email).trim().toLowerCase(),
  personalEmail: String(personalEmail||'').trim().toLowerCase(),
  dept: String(dept||'').trim(),
  tier: String(tier||'Executive').trim(),            // NEW
  position: String(position||'').trim(),             // NEW
  status: String(status||'Active').trim(),
  mfaEnabled: !!mfaEnabled,
  notes: String(notes||'').trim(),

  staffNo: String((req.body?.staffNo)||'').trim(),
  address: String((req.body?.address)||'').trim(),
  idNo: String((req.body?.idNo)||'').trim(),
  passportNo: String((req.body?.passportNo)||'').trim(),
  hireDate: req.body?.hireDate ? new Date(req.body.hireDate) : null,

  carReg: String((req.body?.carReg)||'').trim(),
  carDesc: String((req.body?.carDesc)||'').trim(),

  nokName: String((req.body?.nokName)||'').trim(),
  nokRelation: String((req.body?.nokRelation)||'').trim(),
  nokPhone: String((req.body?.nokPhone)||'').trim(),
  emergencyNotes: String((req.body?.emergencyNotes)||'').trim(),

  family: cleanFamily(req.body.family),

  createdAt: new Date(),
  updatedAt: new Date()
};


    const db = await staffDb();
    const r = await staffColl(db).insertOne(doc);
    res.json({ ok:true, _id: String(r.insertedId) });
  }catch(e){
    console.error('[STAFF] create error', e);
    res.status(500).json({ ok:false, error:'Create failed' });
  }
});

// PUT /api/staff/:id  (update selected fields, don’t drop unknown fields)
app.put('/api/staff/:id', async (req, res) => {
  try{
    const id = req.params.id;
    if(!ObjectId.isValid(id)) return res.status(400).send('Bad id');

    const b = req.body || {};
    const $set = { updatedAt: new Date() };

    if (b.name        !== undefined) $set.name        = String(b.name).trim();
    if (b.email       !== undefined) $set.email       = String(b.email).trim().toLowerCase();
    if (b.dept        !== undefined) $set.dept        = String(b.dept).trim();
    if (b.role        !== undefined) $set.role        = String(b.role).trim();
    if (b.status      !== undefined) $set.status      = String(b.status).trim();
    if (b.mfaEnabled  !== undefined) $set.mfaEnabled  = !!(b.mfaEnabled === true || b.mfaEnabled === 'true' || b.mfaEnabled === 'on' || b.mfaEnabled === 1 || b.mfaEnabled === '1');
    if (b.notes       !== undefined) $set.notes       = String(b.notes).trim();

    // employment + vehicle + identity + address + NOK
    var staffVal = (b.staffNo != null ? b.staffNo : (b.staff_number != null ? b.staff_number : b.staff_no));
    if (staffVal   !== undefined) $set.staffNo     = String(staffVal || '').trim();
    if (b.hireDate !== undefined) $set.hireDate    = String(b.hireDate || '').trim();
    if (b.carReg   !== undefined) $set.carReg      = String(b.carReg   || '').trim();
    if (b.carDesc  !== undefined) $set.carDesc     = String(b.carDesc  || '').trim();
    if (b.address  !== undefined) $set.address     = String(b.address  || '').trim();
    if (b.idNo     !== undefined) $set.idNo        = String(b.idNo     || '').trim();
    if (b.passportNo !== undefined) $set.passportNo  = String(b.passportNo || '').trim();
    if (b.nokName  !== undefined) $set.nokName     = String(b.nokName  || '').trim();
    if (b.nokRelation !== undefined) $set.nokRelation = String(b.nokRelation || '').trim();
    if (b.nokPhone !== undefined) $set.nokPhone    = String(b.nokPhone || '').trim();
    if (b.emergencyNotes !== undefined) $set.emergencyNotes = String(b.emergencyNotes || '').trim();

    if (b.family !== undefined) $set.family = cleanFamily(b.family);

    if (req.body && 'tier' in req.body)      $set.tier = String(req.body.tier||'').trim();
if (req.body && 'position' in req.body)  $set.position = String(req.body.position||'').trim();
if (req.body && 'personalEmail' in req.body) $set.personalEmail = String(req.body.personalEmail||'').trim().toLowerCase();


    const db = await staffDb();
    const r = await staffColl(db).updateOne({ _id: new ObjectId(id) }, { $set });
    res.json({ ok:true, matched: r.matchedCount, modified: r.modifiedCount });
  }catch(e){
    console.error('[STAFF] update error', e);
    res.status(500).json({ ok:false, error:'Update failed' });
  }
});

// PATCH /api/staff/:id/status  (enable/disable)
app.patch('/api/staff/:id/status', async (req, res) => {
  try{
    const id = req.params.id;
    if(!ObjectId.isValid(id)) return res.status(400).send('Bad id');
    const next = (req.body && req.body.status) ? String(req.body.status) : 'Active';

    const db = await staffDb();
    const r = await staffColl(db).updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: next, updatedAt: new Date() } }
    );
    res.json({ ok:true, matched: r.matchedCount, modified: r.modifiedCount });
  }catch(e){
    console.error('[STAFF] status error', e);
    res.status(500).json({ ok:false, error:'Status change failed' });
  }
});

// DELETE /api/staff/:id  (soft delete)
app.delete('/api/staff/:id', async (req, res) => {
  try{
    const id = req.params.id;
    if(!ObjectId.isValid(id)) return res.status(400).send('Bad id');
    const db = await staffDb();
    const r = await staffColl(db).updateOne(
      { _id: new ObjectId(id) },
      { $set: { archivedAt: new Date(), updatedAt: new Date() } }
    );
    res.json({ ok:true, archived: r.modifiedCount });
  }catch(e){
    console.error('[STAFF] delete error', e);
    res.status(500).json({ ok:false, error:'Delete failed' });
  }
});
/* -------------------------------------------------------------------- */

const uploadAssetPhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    const ok = /image\/(jpeg|png|webp)/i.test(file.mimetype);
    cb(ok ? null : new Error('Only JPG/PNG/WEBP images allowed'), ok);
  }
});


// === Assets API ===

// List
app.get('/api/assets', async (req, res) => {
  try{
    const db = await licDb(); // reuse same DB helper
    const items = await assetsColl(db).find({ isDeleted: { $ne: true } })
      .project({ })
      .sort({ assetTag: 1 })
      .toArray();
    res.json(items);
  }catch(e){
    console.error('[ASSETS] list', e);
    res.status(500).json({ ok:false, error:'List failed' });
  }
});

// Details
app.get('/api/assets/:id', async (req, res) => {
  try{
    const db = await licDb();
    const _id = new ObjectId(req.params.id);
    const x = await assetsColl(db).findOne({ _id, isDeleted: { $ne:true } });
    if (!x) return res.status(404).send('Not found');
    res.json(x);
  }catch(e){
    console.error('[ASSETS] details', e);
    res.status(500).json({ ok:false, error:'Details failed' });
  }
});

// Create
app.post('/api/assets', async (req, res) => {
  try{
    const b = req.body || {};
    if (!b.assetTag || !b.name) {
      return res.status(400).json({ ok:false, error:'assetTag and name are required' });
    }
    const doc = {
      assetTag: String(b.assetTag).trim(),
      name: String(b.name).trim(),
      category: String(b.category || 'Other').trim(),
      location: String(b.location || '').trim(),
      status: String(b.status || 'Active').trim(),
      vendor: String(b.vendor || '').trim(),
      serialNo: String(b.serialNo || '').trim(),
      cost: Number.isFinite(+b.cost) ? +b.cost : 0,
      purchaseDate: b.purchaseDate ? new Date(b.purchaseDate) : null,
      warrantyEnd:  b.warrantyEnd  ? new Date(b.warrantyEnd)  : null,
      ownerEmail: String(b.ownerEmail || '').trim(),
      notes: String(b.notes || '').trim(),
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const db = await licDb();
    const r = await assetsColl(db).insertOne(doc);
    res.json({ ok:true, _id: String(r.insertedId) });
  }catch(e){
    console.error('[ASSETS] create', e);
    res.status(500).json({ ok:false, error:'Create failed' });
  }
});

// Update
app.put('/api/assets/:id', async (req, res) => {
  try{
    const b = req.body || {};
    const _id = new ObjectId(req.params.id);
    const $set = {
      assetTag: String(b.assetTag || '').trim(),
      name: String(b.name || '').trim(),
      category: String(b.category || 'Other').trim(),
      location: String(b.location || '').trim(),
      status: String(b.status || 'Active').trim(),
      vendor: String(b.vendor || '').trim(),
      serialNo: String(b.serialNo || '').trim(),
      cost: Number.isFinite(+b.cost) ? +b.cost : 0,
      purchaseDate: b.purchaseDate ? new Date(b.purchaseDate) : null,
      warrantyEnd:  b.warrantyEnd  ? new Date(b.warrantyEnd)  : null,
      ownerEmail: String(b.ownerEmail || '').trim(),
      notes: String(b.notes || '').trim(),
      updatedAt: new Date()
    };
    const db = await licDb();
    await assetsColl(db).updateOne({ _id }, { $set });
    res.json({ ok:true, _id: String(_id) });
  }catch(e){
    console.error('[ASSETS] update', e);
    res.status(500).json({ ok:false, error:'Update failed' });
  }
});

// Delete (soft)
app.delete('/api/assets/:id', async (req, res) => {
  try{
    const db = await licDb();
    const _id = new ObjectId(req.params.id);
    await assetsColl(db).updateOne({ _id }, { $set: { isDeleted:true, updatedAt:new Date() } });
    res.json({ ok:true });
  }catch(e){
    console.error('[ASSETS] delete', e);
    res.status(500).json({ ok:false, error:'Delete failed' });
  }
});

// === Asset Photo API ===

// Upload/replace photo
app.post('/api/assets/:id/photo', uploadAssetPhoto.single('file'), async (req, res) => {
  let db, _id;
  try {
    db = await licDb(); // use your existing DB helper
    try {
      _id = new ObjectId(String(req.params.id));
    } catch {
      return res.status(400).send('Invalid asset id');
    }

    const asset = await assetsColl(db).findOne({ _id, isDeleted: { $ne: true } });
    if (!asset) return res.status(404).send('Asset not found');
    if (!req.file) return res.status(400).send('No file');

    // Remove old photo quietly (if exists)
    if (asset.photoFileId) {
      try { await assetPhotosBucket(db).delete(new ObjectId(String(asset.photoFileId))); } catch(_){}
    }

    // Store to GridFS, wait for completion
    const bucket = assetPhotosBucket(db);
    const filename = `asset_${String(_id)}_${Date.now()}`;
    const stream = bucket.openUploadStream(filename, { contentType: req.file.mimetype });

    // write and wait for finish
    stream.end(req.file.buffer, async (err) => {
      if (err) {
        console.error('[ASSET PHOTO upload end error]', err);
        return res.status(500).send('Upload failed');
      }
      try {
        await assetsColl(db).updateOne({ _id }, { $set: { photoFileId: stream.id, updatedAt: new Date() } });
        return res.json({ ok: true, fileId: String(stream.id) });
      } catch (e) {
        console.error('[ASSET PHOTO post-update error]', e);
        return res.status(500).send('Upload metadata failed');
      }
    });
  } catch (e) {
    console.error('[ASSET PHOTO upload fatal]', e);
    return res.status(500).send('Upload failed');
  }
});


// Get photo
app.get('/api/assetphoto/:fileId', async (req, res) => {
  try{
    const db = await licDb();
    const fid = new ObjectId(req.params.fileId);
    const bucket = assetPhotosBucket(db);

    // set content-type from file metadata if present
    const files = await bucket.find({ _id: fid }).toArray();
    if (!files || !files.length) return res.status(404).send('Not found');
    const meta = files[0];

    res.set('Cache-Control', 'public, max-age=86400');
    if (meta && meta.contentType) res.type(meta.contentType);

    bucket.openDownloadStream(fid).pipe(res);
  }catch(e){
    res.status(404).send('Not found');
  }
});

// Remove photo (optional endpoint)
app.delete('/api/assets/:id/photo', async (req, res) => {
  try{
    const db = await licDb();
    const _id = new ObjectId(req.params.id);
    const asset = await assetsColl(db).findOne({ _id, isDeleted: { $ne:true } });
    if (!asset) return res.status(404).send('Asset not found');
    if (asset.photoFileId){
      try { await assetPhotosBucket(db).delete(new ObjectId(asset.photoFileId)); } catch(_){}
    }
    await assetsColl(db).updateOne({ _id }, { $unset: { photoFileId: "" }, $set: { updatedAt: new Date() } });
    res.json({ ok:true });
  }catch(e){
    console.error('[ASSET PHOTO delete]', e);
    res.status(500).json({ ok:false });
  }
});


// === Announcements API ===

// Admin list (all, for table)
app.get('/api/admin/announcements', async (req, res) => {
  try{
    const db = await licDb();
    const items = await announcementsColl(db).find({ deleted: { $ne:true } })
      .sort({ pinned:-1, startAt:-1, createdAt:-1 }).toArray();
    res.json(items);
  }catch(e){ console.error('[ANN] list', e); res.status(500).json([]); }
});

// Create
app.post('/api/admin/announcements', async (req, res) => {
  try{
    const b = req.body || {};
    if(!b.title || !b.body || !b.startAt || !b.endAt) return res.status(400).json({ ok:false, error:'Missing fields' });
    const doc = {
      title: String(b.title).trim(),
      category: String(b.category||'').trim(),
      body: String(b.body||'').trim(),
      startAt: new Date(b.startAt),
      endAt: new Date(b.endAt),
      pinned: !!b.pinned,
      deployed: !!b.deployNow, // immediate deploy flag
      deleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      authorEmail: (req.user && req.user.email) || null
    };
    const db = await licDb();
    const r = await announcementsColl(db).insertOne(doc);
    res.json({ ok:true, _id:String(r.insertedId) });
  }catch(e){ console.error('[ANN] create', e); res.status(500).json({ ok:false }); }
});

// Update
app.put('/api/admin/announcements/:id', async (req, res) => {
  try{
    const b = req.body || {};
    const _id = new ObjectId(req.params.id);
    const $set = {
      title: String(b.title||'').trim(),
      category: String(b.category||'').trim(),
      body: String(b.body||'').trim(),
      startAt: b.startAt ? new Date(b.startAt) : null,
      endAt:   b.endAt   ? new Date(b.endAt)   : null,
      pinned: !!b.pinned,
      updatedAt: new Date()
    };
    const db = await licDb();
    await announcementsColl(db).updateOne({ _id }, { $set });
    res.json({ ok:true });
  }catch(e){ console.error('[ANN] update', e); res.status(500).json({ ok:false }); }
});

// Deploy toggle
app.post('/api/admin/announcements/:id/deploy', async (req, res) => {
  try{
    const _id = new ObjectId(req.params.id);
    const on = !!(req.body && req.body.deployed);
    const db = await licDb();
    await announcementsColl(db).updateOne({ _id }, { $set: { deployed:on, updatedAt:new Date() } });
    res.json({ ok:true, deployed:on });
  }catch(e){ console.error('[ANN] deploy', e); res.status(500).json({ ok:false }); }
});

// Soft delete
app.delete('/api/admin/announcements/:id', async (req, res) => {
  try{
    const _id = new ObjectId(req.params.id);
    const db = await licDb();
    await announcementsColl(db).updateOne({ _id }, { $set: { deleted:true, deployed:false, updatedAt:new Date() } });
    res.json({ ok:true });
  }catch(e){ console.error('[ANN] delete', e); res.status(500).json({ ok:false }); }
});

// Public feed for dashboard (testdash)
app.get('/api/announcements', async (req, res) => {
  try{
    const now = new Date();
    const db = await licDb();
    const items = await announcementsColl(db).find({
      deleted: { $ne:true },
      deployed: true,
      startAt: { $lte: now },
      endAt:   { $gt: now }
    }).project({ title:1, category:1, body:1, startAt:1, endAt:1, pinned:1, createdAt:1 })
      .sort({ pinned:-1, startAt:-1, createdAt:-1 })
      .limit(10)
      .toArray();
    res.json(items);
  }catch(e){ console.error('[ANN] public', e); res.status(500).json([]); }
});



function cleanFamily(v){
  if (!v) return [];
  try{
    const arr = Array.isArray(v) ? v : JSON.parse(v);
    return arr.filter(Boolean).map(m=>({
      name: String((m && m.name) || '').trim(),
      dob:  m && m.dob ? new Date(m.dob) : null,
      relation: String((((m && m.relation) != null ? m.relation : (m && m.relationship)) || '')).trim(),
      phone: String((m && m.phone) || '').trim(),
      notes: String((m && m.notes) || '').trim()
    }));
  }catch(_){ return []; }
}





// (C) Your existing /api/commonFiles mount — unchanged, keep right here below:
console.log('[BOOT] mount /api/commonFiles');
app.use('/api', (req, _res, next) => {
  console.log(`[HIT] ...API ${req.method} ${req.originalUrl}`);
  next();
}, commonFiles);




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
app.listen(PORT, () => console.log(`Staff portal running on ${PORT}`));
