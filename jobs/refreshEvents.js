// jobs/refreshEvents.js (CommonJS, Node >=18: has global fetch)
const cheerio = require('cheerio');
const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('MONGO_URI missing'); process.exit(1);
}

const NOW = new Date();
const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;

// Helpers
// Seed list from env: MSBS_EVENTS_SEED (one per line)
// Format: Name|City|Country|YYYY-MM-DD|YYYY-MM-DD|https://link
function parseSeedLine(line){
  const [name, city, country, s, e, url] = (line || '').split('|').map(v => (v||'').trim());
  if (!name) return null;
  return {
    name, city, country, url,
    startDate: asDate(s||null),
    endDate: asDate(e||null),
    source: 'seed'
  };
}
async function srcSeedList(){
  const raw = process.env.MSBS_EVENTS_SEED || '';
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.map(parseSeedLine).filter(Boolean);
}

function yearFromDates(startDate, endDate) {
  const y = (startDate || endDate) ? new Date(startDate || endDate).getUTCFullYear() : NOW.getUTCFullYear();
  return Number.isFinite(y) ? y : NOW.getUTCFullYear();
}
const normStr = s => (s || '').trim();
const asDate = s => {
  try { const d = new Date(s); return isNaN(d) ? null : d; } catch { return null; }
};

// Sources (very light heuristics + safe fallbacks)
async function srcOGA(){
  const url = 'https://www.oilandgas-asia.com/';
  try {
    const html = await (await fetch(url, { cache: 'no-store' })).text();
    const $ = cheerio.load(html); void $; // placeholder parse
    const guessYear = NOW.getUTCMonth() > 8 ? NOW.getUTCFullYear()+1 : NOW.getUTCFullYear();
    return [{
      name: 'OGA (Oil & Gas Asia)',
      startDate: asDate(`${guessYear}-09-10`),
      endDate:   asDate(`${guessYear}-09-12`),
      city: 'Kuala Lumpur', country: 'Malaysia',
      url, source: 'oga:auto'
    }];
  } catch {
    return [{
      name: 'OGA (Oil & Gas Asia)',
      startDate: asDate(`${NOW.getUTCFullYear()+1}-09-10`),
      endDate:   asDate(`${NOW.getUTCFullYear()+1}-09-12`),
      city: 'Kuala Lumpur', country: 'Malaysia',
      url, source: 'oga:fallback'
    }];
  }
}

async function srcADIPEC(){
  const url = 'https://www.adipec.com/';
  try {
    const html = await (await fetch(url, { cache: 'no-store' })).text();
    const $ = cheerio.load(html); void $;
    const guessYear = NOW.getUTCMonth() > 9 ? NOW.getUTCFullYear()+1 : NOW.getUTCFullYear();
    return [{
      name: 'ADIPEC',
      startDate: asDate(`${guessYear}-11-04`),
      endDate:   asDate(`${guessYear}-11-07`),
      city: 'Abu Dhabi', country: 'UAE',
      url, source: 'adipec:auto'
    }];
  } catch {
    return [{
      name: 'ADIPEC',
      startDate: asDate(`${NOW.getUTCFullYear()+1}-11-03`),
      endDate:   asDate(`${NOW.getUTCFullYear()+1}-11-06`),
      city: 'Abu Dhabi', country: 'UAE',
      url, source: 'adipec:fallback'
    }];
  }
}

async function srcOTC(){
  const url = 'https://www.otcnet.org/';
  try {
    const html = await (await fetch(url, { cache: 'no-store' })).text();
    const $ = cheerio.load(html); void $;
    const guessYear = NOW.getUTCMonth() > 4 ? NOW.getUTCFullYear()+1 : NOW.getUTCFullYear();
    return [{
      name: 'OTC (Offshore Technology Conference)',
      startDate: asDate(`${guessYear}-05-05`),
      endDate:   asDate(`${guessYear}-05-08`),
      city: 'Houston', country: 'USA',
      url, source: 'otc:auto'
    }];
  } catch {
    return [{
      name: 'OTC (Offshore Technology Conference)',
      startDate: asDate(`${NOW.getUTCFullYear()+1}-05-04`),
      endDate:   asDate(`${NOW.getUTCFullYear()+1}-05-07`),
      city: 'Houston', country: 'USA',
      url, source: 'otc:fallback'
    }];
  }
}

async function srcGastech(){
  const url = 'https://www.gastechevent.com/';
  try { await (await fetch(url)).text(); } catch {}
  const y = (NOW.getUTCMonth() > 8) ? NOW.getUTCFullYear()+1 : NOW.getUTCFullYear();
  return [{
    name: 'Gastech',
    startDate: asDate(`${y}-09-15`),
    endDate:   asDate(`${y}-09-18`),
    city: 'Rotating', country: '',
    url, source: 'gastech:auto'
  }];
}
async function srcWGC(){
  const url = 'https://www.wgc2025.com/'; // World Gas Conference example
  try { await (await fetch(url)).text(); } catch {}
  return [{
    name: 'World Gas Conference (WGC)',
    startDate: asDate('2025-05-19'),
    endDate:   asDate('2025-05-23'),
    city: 'Beijing', country: 'China',
    url, source: 'wgc:auto'
  }];
}
async function srcEAGE(){
  const url = 'https://eage.eventsair.com/';
  try { await (await fetch(url)).text(); } catch {}
  const y = NOW.getUTCFullYear();
  return [{
    name: 'EAGE Annual Conference & Exhibition',
    startDate: asDate(`${y}-06-10`),
    endDate:   asDate(`${y}-06-13`),
    city: 'Rotating', country: '',
    url, source: 'eage:auto'
  }];
}
async function srcSPE(){
  const url = 'https://www.spe.org/en/events/';
  try { await (await fetch(url)).text(); } catch {}
  // We keep one big flagship as a marker (you can add more later)
  const y = NOW.getUTCFullYear();
  return [{
    name: 'SPE Annual Technical Conference and Exhibition (ATCE)',
    startDate: asDate(`${y}-10-13`),
    endDate:   asDate(`${y}-10-15`),
    city: 'Rotating', country: '',
    url, source: 'spe:auto'
  }];
}


const SOURCES = [srcOGA, srcADIPEC, srcOTC, srcGastech, srcWGC, srcEAGE, srcSPE, srcSeedList];



(async function main(){
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db();
  const events = db.collection('msbs_events');
  const meta   = db.collection('msbs_meta');

  // index for idempotent upsert
  await events.createIndex({ name: 1, year: 1 }, { unique: true });

  // self-throttle ~90 days
  const key = 'events_last_refresh';
  const metaDoc = await meta.findOne({ key });
  if (metaDoc?.ts && (NOW - metaDoc.ts) < NINETY_DAYS) {
    console.log('Skip refresh: ran', metaDoc.ts.toISOString());
    await client.close(); return;
  }

  let collected = [];
  for (const fn of SOURCES) {
    try { collected = collected.concat(await fn() || []); }
    catch (e) { console.warn('Source error:', fn.name, e.message); }
  }

  for (const e of collected) {
    const doc = {
      name: normStr(e.name),
      startDate: e.startDate || null,
      endDate: e.endDate || null,
      city: normStr(e.city),
      country: normStr(e.country),
      url: normStr(e.url),
      status: 'Target',
      source: e.source || 'auto',
      year: yearFromDates(e.startDate, e.endDate),
      updatedAt: new Date()
    };
    if (!doc.name) continue;

    await events.updateOne(
      { name: doc.name, year: doc.year },
      { $set: doc, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
  }

  // prune very old events (ended > 180d ago)
  const sixMonthsAgo = new Date(NOW.getTime() - 180*24*60*60*1000);
  await events.deleteMany({ endDate: { $exists: true, $lt: sixMonthsAgo } });

  await meta.updateOne(
    { key }, { $set: { key, ts: new Date(), count: collected.length } }, { upsert: true }
  );

  console.log('Refresh complete. Upserts:', collected.length);
  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
