// server/db.js
const { MongoClient, GridFSBucket, ObjectId } = require('mongodb');

const uri =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.MONGOURL ||
  process.env.MONGO_URL;

if (!uri) {
  console.error("[BOOT] No Mongo URI found. Set MONGO_URI (or MONGODB_URI) in Heroku Config Vars.");
  throw new Error("MONGO_URI missing");
}

let _client, _db, _bucket;

async function connect() {
  if (_db) return _db;
  _client = new MongoClient(uri);
  await _client.connect();
  _db = _client.db("Asianloop");
  _bucket = new GridFSBucket(_db, { bucketName: "commonFiles" });
  return _db;
}
function db() { if (!_db) throw new Error("DB not connected yet"); return _db; }
function bucket() { if (!_bucket) throw new Error("Bucket not ready"); return _bucket; }
function oid(id) { return new ObjectId(id); }

module.exports = { connect, db, bucket, oid };
