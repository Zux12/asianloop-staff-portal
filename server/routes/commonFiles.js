// server/routes/commonFiles.js
const express = require('express');
const multer = require('multer');
const { Readable } = require('stream');
const { db, bucket, oid } = require('../db');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 512 } }); // 512MB

// Helpers
const foldersCol = () => db().collection('folders');
const filesMetaCol = () => db().collection('files_meta');
const eventsCol = () => db().collection('file_events');

function actorFromReq(req) {
  const email =
    (req.session?.user?.email) ||        // ✅ your login session
    (req.user?.email) ||
    (req.headers['x-user-email']) ||
    'unknown@asian-loop.com';

  const id =
    (req.session?.user?.id) ||
    (req.user?.id) ||
    (req.headers['x-user-id']) ||
    null;

  return { id, email: String(email) };
}


// --- FOLDERS ---

// Create a folder
router.post('/folders', async (req, res, next) => {
  try {
    const { name, parentId = null } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: "name required" });
    const actor = actorFromReq(req);

    const doc = {
      name: name.trim(),
      parentId: parentId ? oid(parentId) : null,
      createdAt: new Date(),
      createdBy: actor,
      updatedAt: new Date(),
      updatedBy: actor,
    };
    const r = await foldersCol().insertOne(doc);
    await eventsCol().insertOne({
      ts: new Date(), actor, action: "create_folder",
      target: { type: "folder", id: r.insertedId, name: doc.name },
      fromFolderId: null, toFolderId: doc.parentId
    });
    res.json({ ok: true, folder: { ...doc, _id: r.insertedId } });
  } catch (e) { next(e); }
});

// List children (folders + files) for a folder (id or "root")
router.get('/folders/:id/children', async (req, res, next) => {
  try {
    const id = req.params.id === 'root' ? null : oid(req.params.id);
    const [folders, files] = await Promise.all([
      foldersCol().find({ parentId: id }).sort({ name: 1 }).toArray(),
      filesMetaCol().find({ folderId: id }).project({ data: 0 }).sort({ name: 1 }).toArray(),
    ]);
    res.json({ folders, files });
  } catch (e) { next(e); }
});

// Breadcrumbs for a folder
router.get('/breadcrumbs', async (req, res, next) => {
  try {
    const { folderId } = req.query;
    const crumbs = [{ _id: 'root', name: 'Root' }];
    if (!folderId || folderId === 'root') return res.json({ breadcrumbs: crumbs });

    let cur = await foldersCol().findOne({ _id: oid(folderId) });
    const chain = [];
    while (cur) {
      chain.unshift({ _id: cur._id, name: cur.name });
      cur = cur.parentId ? await foldersCol().findOne({ _id: cur.parentId }) : null;
    }
    res.json({ breadcrumbs: crumbs.concat(chain) });
  } catch (e) { next(e); }
});

// --- FILES ---

// Upload file to a folder
router.post('/files/upload', upload.single('file'), async (req, res, next) => {
  try {
    const actor = actorFromReq(req);
    const folderId = req.query.folderId && req.query.folderId !== 'root' ? oid(req.query.folderId) : null;
    if (!req.file) return res.status(400).json({ error: "file required" });

    // Stream into GridFS
    const meta = {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
      metadata: { uploadedBy: actor.email, folderId: folderId || null }
    };

    const rs = Readable.from(req.file.buffer);
    const uploadStream = bucket().openUploadStream(meta.filename, { contentType: meta.contentType, metadata: meta.metadata });
    rs.pipe(uploadStream).on('error', next).on('finish', async () => {
      const fileId = uploadStream.id;

      const fm = {
        _id: fileId,
        name: meta.filename,
        folderId,
        mimeType: meta.contentType,
        size: req.file.size,
        uploadedAt: new Date(),
        uploadedBy: actor,
        lastAccessAt: null,
        lastAccessBy: null,
        version: 1,
        tags: [],
        notes: ""
      };
      await filesMetaCol().insertOne(fm);

      await eventsCol().insertOne({
        ts: new Date(), actor, action: "upload",
        target: { type: "file", id: fileId, name: fm.name },
        fromFolderId: null, toFolderId: folderId
      });

      res.json({ ok: true, file: fm });
    });
  } catch (e) { next(e); }
});

// Download file
router.get('/files/:id/download', async (req, res, next) => {
  try {
    const id = oid(req.params.id);
    const fm = await filesMetaCol().findOne({ _id: id });
    if (!fm) return res.status(404).json({ error: "not found" });

    // Update last access
    const actor = actorFromReq(req);
    await filesMetaCol().updateOne({ _id: id }, { $set: { lastAccessAt: new Date(), lastAccessBy: actor } });
    await eventsCol().insertOne({
      ts: new Date(), actor, action: "download",
      target: { type: "file", id, name: fm.name }, fromFolderId: fm.folderId, toFolderId: fm.folderId
    });

    res.setHeader('Content-Type', fm.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fm.name)}"`);
    bucket().openDownloadStream(id).on('error', next).pipe(res);
  } catch (e) { next(e); }
});

// File properties
router.get('/files/:id/properties', async (req, res, next) => {
  try {
    const id = oid(req.params.id);
    const [fm, recent] = await Promise.all([
      filesMetaCol().findOne({ _id: id }),
      eventsCol().find({ 'target.id': id }).sort({ ts: -1 }).limit(10).toArray()
    ]);
    if (!fm) return res.status(404).json({ error: "not found" });
    res.json({ file: fm, events: recent });
  } catch (e) { next(e); }
});

// Delete (owner or admin)
router.delete('/files/:id', async (req, res, next) => {
  try {
    const id = oid(req.params.id);
    const actor = actorFromReq(req);
    const fm = await filesMetaCol().findOne({ _id: id });
    if (!fm) return res.status(404).json({ error: "not found" });

    const isOwner = fm.uploadedBy?.email === actor.email;
    const isAdmin = (req.user?.role === 'admin') || (req.headers['x-user-role'] === 'admin');
    if (!isOwner && !isAdmin) return res.status(403).json({ error: "not allowed" });

    await bucket().delete(id);
    await filesMetaCol().deleteOne({ _id: id });
    await eventsCol().insertOne({
      ts: new Date(), actor, action: "delete",
      target: { type: "file", id, name: fm.name }, fromFolderId: fm.folderId, toFolderId: null
    });

    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
