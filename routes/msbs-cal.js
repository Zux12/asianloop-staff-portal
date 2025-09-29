// routes/msbs-cal.js
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');

const router = express.Router();

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URL;
const MONGODB_DB  = process.env.MONGODB_DB  || process.env.MONGO_DB || 'asianloop';
const ADMIN_LIST  = String(process.env.MSBS_ADMIN_EMAILS || '').toLowerCase()
  .split(',').map(s=>s.trim()).filter(Boolean);

if (!MONGODB_URI) {
  console.error('[msbs-cal] Missing MONGODB_URI env var.');
}

let _client, _db;
async function getDB(){
  if (_db) return _db;
  _client = new MongoClient(MONGODB_URI, { ignoreUndefined:true });
  await _client.connect();
  _db = _client.db(MONGODB_DB);
  // indexes
  const col = _db.collection('msbs_cal_events');
  await col.createIndex({ start:1 });
  await col.createIndex({ end:1 });
  await col.createIndex({ staffEmail:1 });
  return _db;
}

function emailFromCookie(req){
  // Read 'al_user_email' like your frontend uses
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)al_user_email=([^;]+)/);
  try { return m ? decodeURIComponent(m[1]) : null; } catch(e){ return null; }
}
function getUserEmail(req){
  return (req.user && req.user.email) ||
         (req.session && req.session.user && req.session.user.email) ||
         req.headers['x-user-email'] ||
         emailFromCookie(req) ||
         null;
}
function isAdmin(email){
  if (!email) return false;
  return ADMIN_LIST.includes(String(email).toLowerCase());
}
function sanitizeEventInput(body){
  const t = (body.type||'').trim();
  const allowed = ['WFH','Onsite','Travel','Leave','Conf','Meeting'];
  if (!allowed.includes(t)) throw new Error('Invalid type');

  const start = new Date(body.start);
  const end   = new Date(body.end);
  if (!(start instanceof Date) || isNaN(+start)) throw new Error('Invalid start');
  if (!(end instanceof Date)   || isNaN(+end))   throw new Error('Invalid end');
  if (end < start) throw new Error('End before start');

  const allday = !!body.allday;
  const location = (body.location||'').trim().slice(0,64);
  const note     = (body.note||'').trim().slice(0,140);
  const title    = (body.title||'').trim().slice(0,60);

  return { type:t, start, end, allday, location, note, title };
}

// GET events overlapping [start,end]
router.get('/api/msbs/cal/events', async (req,res)=>{
  try{
    const db = await getDB();
    const col = db.collection('msbs_cal_events');
    const start = new Date(req.query.start);
    const end   = new Date(req.query.end);
    if (isNaN(+start) || isNaN(+end)) return res.status(400).send('Invalid range');

    const q = { $and: [ { start: { $lte: end } }, { end: { $gte: start } } ] };
    const docs = await col.find(q, { projection:{ /* all */ } }).sort({ start:1 }).toArray();
    res.json(docs.map(d=>({
      _id: String(d._id),
      staffEmail: d.staffEmail,
      staffName: d.staffName || '',
      type: d.type, location: d.location || '',
      start: d.start, end: d.end, allday: !!d.allday,
      note: d.note || '', title: d.title || ''
    })));
  }catch(e){ console.error(e); res.status(500).send('Server error'); }
});

// POST create (owner = logged-in user)
router.post('/api/msbs/cal/events', express.json(), async (req,res)=>{
  try{
    const email = getUserEmail(req);
    if (!email) return res.status(401).send('Auth required');
    const input = sanitizeEventInput(req.body);
    const db = await getDB();
    const col = db.collection('msbs_cal_events');
    const now = new Date();
    const doc = {
      staffEmail: String(email),
      staffName: (req.user && (req.user.name||req.user.displayName)) || '',
      ...input,
      createdAt: now,
      updatedAt: now
    };
    const r = await col.insertOne(doc);
    res.json({ ok:true, _id: String(r.insertedId) });
  }catch(e){ console.error(e); res.status(400).send(e.message || 'Bad request'); }
});

// PATCH update (owner or admin)
router.patch('/api/msbs/cal/events/:id', express.json(), async (req,res)=>{
  try{
    const email = getUserEmail(req);
    if (!email) return res.status(401).send('Auth required');
    const id = req.params.id;
    const input = sanitizeEventInput(req.body);
    const db = await getDB();
    const col = db.collection('msbs_cal_events');
    const doc = await col.findOne({ _id: new ObjectId(id) });
    if (!doc) return res.status(404).send('Not found');
    if (String(doc.staffEmail||'').toLowerCase() !== String(email).toLowerCase() && !isAdmin(email)) {
      return res.status(403).send('Not allowed');
    }
    const r = await col.updateOne({ _id:new ObjectId(id) }, { $set: { ...input, updatedAt:new Date() } });
    res.json({ ok:true, modified: r.modifiedCount });
  }catch(e){ console.error(e); res.status(400).send(e.message || 'Bad request'); }
});

// DELETE (owner or admin)
router.delete('/api/msbs/cal/events/:id', async (req,res)=>{
  try{
    const email = getUserEmail(req);
    if (!email) return res.status(401).send('Auth required');
    const id = req.params.id;
    const db = await getDB();
    const col = db.collection('msbs_cal_events');
    const doc = await col.findOne({ _id:new ObjectId(id) });
    if (!doc) return res.status(404).send('Not found');
    if (String(doc.staffEmail||'').toLowerCase() !== String(email).toLowerCase() && !isAdmin(email)) {
      return res.status(403).send('Not allowed');
    }
    const r = await col.deleteOne({ _id:new ObjectId(id) });
    res.json({ ok:true, deleted: r.deletedCount });
  }catch(e){ console.error(e); res.status(400).send(e.message || 'Bad request'); }
});

module.exports = router;
