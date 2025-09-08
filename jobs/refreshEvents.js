// jobs/refreshEvents.js
// Purpose: refresh msbs_events from curated sources, but only once ~every 90 days.
// Safe to run weekly via Heroku Scheduler; self-throttles via msbs_meta.

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('MONGO_URI missing'); process.exit(1);
}

const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
const NOW = new Date();

// --- Helpers ---
function yearFromDates(startDate, endDate) {
  const y = (startDate || endDate) ? new Date(startDate || endDate).getUTCFullYear() : NOW.getUTCFullYear();
  return Number.isFinite(y) ? y : NOW.getUTCFullYear();
}
function normStr(s){ return (s || '').trim(); }
function asDate(s){
  try { const d = new Date(s); return isNaN(d.getTime()) ? null : d; } catch { return null; }
}

// --- Source adapters (return array of {name,startDate,endDate,city,country,url,source}) ---
// Keep these simple; we can harden later if sites change.

async function srcOGA(){
  // OGA — dates vary; if parsing fails, keep a sensible placeholder
  const url = 'https://www.oilandgas-asia.com/';
  try {
    const html = await (await fetch(url, { timeout: 15000 })).text();
    const $ = cheerio.load(html);
    // Try to find a date-like snippet on homepage
    const bodyText = $('body').text();
    // naive year guess (next year or current)
    const guessYear = NOW.getUTCMonth() > 8 ? NOW.getUTCFullYear()+1 : NOW.getUTCFullYear();
    return [{
      name: 'OGA (Oil & Gas Asia)',
      startDate: asDate(`${guessYear}-09-10`),
      endDate:   asDate(`${guessYear}-09-12`),
      city: 'Kuala Lumpur', country: 'Malaysia',
      url, source: 'oga:auto'
    }];
  } catch {
    // Fallback static
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
    const html = await (await fetch(url, { timeout: 15000 })).text();
    const $ = cheerio.load(html);
    const text = $('body').text();
    // very light heuristic; dates often in Nov
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
    const html = await (await fetch(url, { timeout: 15000 })).text();
    const $ = cheerio.load(html);
    const text = $('body').text();
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

// Add or remove sources here
const SOURCES = [srcOGA, srcADIPEC, srcOTC];

async function main(){
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(); // DB name is taken from MONGO_URI path
  const events = db.collection('msbs_events');
  const meta   = db.collection('msbs_meta');

  // Ensure index for idempotent upsert (name + year)
  await events.createIndex({ name: 1, year: 1 }, { unique: true });

  // Self-throttle: only run if 90+ days since last refresh
  const key = 'events_last_refresh';
  const metaDoc = await meta.findOne({ key });
  if (metaDoc?.ts && (NOW - metaDoc.ts) < NINETY_DAYS) {
    console.log('Skip refresh: ran recently on', metaDoc.ts.toISOString());
    await client.close(); return;
  }

  let collected = [];
  for (const fn of SOURCES) {
    try {
      const rows = await fn();
      collected = collected.concat(rows || []);
    } catch (e) {
      console.warn('Source error:', fn.name, e.message);
    }
  }

  // Normalize & upsert
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

  // Optional: prune very old events (ended > 180 days ago)
  const sixMonthsAgo = new Date(NOW.getTime() - 180*24*60*60*1000);
  await events.deleteMany({ endDate: { $exists: true, $lt: sixMonthsAgo } });

  // Update meta timestamp
  await meta.updateOne(
    { key },
    { $set: { key, ts: new Date(), count: collected.length } },
    { upsert: true }
  );

  console.log('Refresh complete. Upserts:', collected.length);
  await client.close();
}

main().catch(e => { console.error(e); process.exit(1); });
