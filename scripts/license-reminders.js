/**
 * Daily 7-day license reminders
 * Runs independently (Heroku Scheduler) and emails admin for licenses
 * with notify7d=true that expire in exactly 7 days AND haven’t been sent yet.
 */
const { MongoClient, ObjectId, GridFSBucket } = require('mongodb');
const nodemailer = require('nodemailer');

(async () => {
  try {
    // env
    const {
      MONGO_URI = process.env.MONGODB_URI,
      SMTP_HOST, SMTP_PORT='465', SMTP_SECURE='true', SMTP_USER, SMTP_PASS, SMTP_FROM,
      ADMIN_NOTIFY_EMAIL = 'mzmohamed@asian-loop.com',
      TZ = 'Asia/Kuala_Lumpur'
    } = process.env;

    if (!MONGO_URI) throw new Error('MONGO_URI missing');
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) throw new Error('SMTP envs missing');

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: (String(SMTP_SECURE) === 'true'),
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });

    const client = new MongoClient(MONGO_URI);
    await client.connect();
    const db = client.db();
    const col = db.collection('licenses');

    // compute target date = today + 7 (in local Asia/KL)
    const now = new Date();
    const kl = new Date(now.toLocaleString('en-GB', { timeZone: TZ }));
    kl.setHours(0,0,0,0);
    const target = new Date(kl); target.setDate(target.getDate() + 60);

    // query: notify7d=true AND endAt is same day as target AND not yet notified for -60d
    const start = new Date(target); start.setHours(0,0,0,0);
    const end   = new Date(target); end.setHours(23,59,59,999);

    const cursor = col.find({
      notify7d: true,
      endAt: { $gte: start, $lte: end },
      $or: [
        { notifications: { $exists: false } },
        { notifications: { $not: { $elemMatch: { when: '-60d' } } } }
      ]
    });

    const items = await cursor.toArray();
    console.log(`[CRON] found ${items.length} license(s) due in 7 days`);

    for (const lic of items) {
      const name = lic.name || '(unnamed)';
      const vendor = lic.vendor || '-';
      const type = lic.type || '-';
      const sdate = lic.startAt ? new Date(lic.startAt).toISOString().slice(0,10) : '-';
      const edate = lic.endAt ? new Date(lic.endAt).toISOString().slice(0,10) : '-';

      const subject = `60-day license reminder — ${name}`;
      const text = [
        `License: ${name}`,
        `Type: ${type}`,
        `Vendor: ${vendor}`,
        `Start: ${sdate}`,
        `Expiry: ${edate}`,
        '',
        `Notes: ${lic.notes || '-'}`,
      ].join('\n');

const toList = String(ADMIN_NOTIFY_EMAIL || 'mzmohamed@asian-loop.com')
  .split(/[;,]/).map(s => s.trim()).filter(Boolean);

const info = await transporter.sendMail({
  from: SMTP_FROM || 'Licensing <licensing@asian-loop.com>',
  to: toList,
  subject, text
});
console.log('[CRON] accepted:', info.accepted, 'rejected:', info.rejected);


      await col.updateOne(
        { _id: new ObjectId(lic._id) },
        { $push: { notifications: { when: '-60d', sentAt: new Date() } } }
      );

      console.log(`[CRON] sent reminder for ${name}`);
    }

    await client.close();
    console.log('[CRON] done');
    process.exit(0);
  } catch (e) {
    console.error('[CRON] error', e);
    process.exit(1);
  }
})();
