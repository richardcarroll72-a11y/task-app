// Vercel Serverless Function — today's readiness from the Health & Wellness Log DB
// GET /api/health?clientDate=YYYY-MM-DD
//
// Returns the most-recent entry on or before clientDate and surfaces a
// numeric readiness score. The property holding the score is auto-detected
// from a small list of common names (override with HEALTH_READINESS_PROP).
//
// Response: { date, readiness, level, propertyUsed } | { readiness: null }
//
// Env:
//   NOTION_TOKEN              — required
//   HEALTH_LOG_DB_ID          — Health & Wellness Log DB (default in code)
//   HEALTH_READINESS_PROP     — optional override for the score property name
//   HEALTH_DATE_PROP          — optional override for the date property name

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const DEFAULT_HEALTH_DB_ID = '3baac66ebaba469490cc05a8ecab1020';
const CANDIDATE_READINESS_PROPS = ['Readiness', 'Readiness Score', 'Score', 'Energy', 'HRV Readiness'];
const CANDIDATE_DATE_PROPS = ['Date', 'Day', 'Logged', 'Created'];

function notionHeaders() {
  return {
    'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

async function fetchNotion(path, options = {}) {
  const res = await fetch(`${NOTION_API}${path}`, {
    ...options,
    headers: { ...notionHeaders(), ...(options.headers || {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Notion API error ${res.status}`);
  }
  return res.json();
}

function extractNumber(prop) {
  if (!prop) return null;
  if (typeof prop.number === 'number') return prop.number;
  if (prop.formula && typeof prop.formula.number === 'number') return prop.formula.number;
  if (prop.rollup && typeof prop.rollup.number === 'number') return prop.rollup.number;
  // Sometimes scores are stored as rich_text/title — try parsing the plain text
  const text = (prop.rich_text || prop.title || [])
    .map(t => t.plain_text || '').join('').trim();
  if (text) {
    const n = parseFloat(text);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

function extractDate(prop) {
  if (!prop) return null;
  if (prop.date && prop.date.start) return prop.date.start;
  if (prop.created_time) return prop.created_time;
  return null;
}

function levelFor(score) {
  if (score == null) return null;
  if (score >= 85) return 'great';
  if (score >= 70) return 'normal';
  if (score >= 55) return 'moderate';
  return 'low';
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN not set' });

  const DB_ID = process.env.HEALTH_LOG_DB_ID || DEFAULT_HEALTH_DB_ID;
  const today = req.query.clientDate || new Date().toISOString().split('T')[0];

  try {
    // Resolve property names from schema (cheap — one call, cacheable)
    const schema = await fetchNotion(`/databases/${DB_ID}`);
    const props = schema.properties || {};

    const readinessProp = process.env.HEALTH_READINESS_PROP
      || CANDIDATE_READINESS_PROPS.find(n => n in props)
      || null;
    const dateProp = process.env.HEALTH_DATE_PROP
      || CANDIDATE_DATE_PROPS.find(n => n in props && props[n].type === 'date')
      || null;

    // Query latest entry on/before today. Sort by date desc when possible.
    const query = { page_size: 5 };
    if (dateProp) {
      query.filter = { property: dateProp, date: { on_or_before: today } };
      query.sorts = [{ property: dateProp, direction: 'descending' }];
    } else {
      query.sorts = [{ timestamp: 'created_time', direction: 'descending' }];
    }

    const data = await fetchNotion(`/databases/${DB_ID}/query`, {
      method: 'POST',
      body: JSON.stringify(query),
    });

    const page = (data.results || [])[0];
    if (!page) {
      res.setHeader('Cache-Control', 's-maxage=300');
      return res.status(200).json({ readiness: null, reason: 'no-entry' });
    }

    const score = readinessProp ? extractNumber(page.properties[readinessProp]) : null;
    const entryDate = dateProp ? extractDate(page.properties[dateProp]) : page.created_time;

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    return res.status(200).json({
      readiness: score,
      level: levelFor(score),
      date: entryDate,
      propertyUsed: readinessProp,
    });
  } catch (err) {
    console.error('health error:', err);
    return res.status(200).json({ readiness: null, error: err.message || 'fetch failed' });
  }
};
