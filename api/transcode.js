// Vercel Serverless Function — transcode status
// GET /api/transcode
//
// Reads from a Notion page OR database whose ID is configured via
// TRANSCODE_PAGE_ID (default: f7db9b70cf994c6991891becc780db3d).
// Auto-detects which it is, since the page URL the user pointed at could
// be either. Returns a small summary the widget can render.
//
// Response shapes:
//   { available: true, source: 'db',   encoding, queue, lastCompleted }
//   { available: true, source: 'page', title, lines: [string, ...] }
//   { available: false, reason }

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const DEFAULT_TRANSCODE_ID = 'f7db9b70cf994c6991891becc780db3d';

const ACTIVE_STATUSES = ['encoding', 'in progress', 'transcoding', 'running', 'active'];
const QUEUED_STATUSES = ['queued', 'pending', 'waiting', 'not started', 'todo'];
const DONE_STATUSES   = ['done', 'completed', 'finished', 'complete'];

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
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}

function titleText(props) {
  for (const v of Object.values(props || {})) {
    if (v.type === 'title') return (v.title || []).map(t => t.plain_text || '').join('').trim();
  }
  return '';
}

function statusText(props) {
  for (const v of Object.values(props || {})) {
    if (v.type === 'status') return v.status?.name || '';
    if (v.type === 'select' && /status/i.test(v.id || '')) return v.select?.name || '';
  }
  // Fallback: any select property named "Status"
  if (props?.Status?.select?.name) return props.Status.select.name;
  if (props?.Status?.status?.name) return props.Status.status.name;
  return '';
}

function bucket(status) {
  const s = (status || '').toLowerCase();
  if (ACTIVE_STATUSES.some(x => s.includes(x))) return 'encoding';
  if (QUEUED_STATUSES.some(x => s.includes(x))) return 'queued';
  if (DONE_STATUSES.some(x => s.includes(x)))   return 'done';
  return 'other';
}

async function readBlocks(pageId) {
  const r = await fetchNotion(`/blocks/${pageId}/children?page_size=20`);
  if (!r.ok) return [];
  const lines = [];
  for (const b of r.body.results || []) {
    const t = b[b.type];
    if (!t || !t.rich_text) continue;
    const text = t.rich_text.map(x => x.plain_text || '').join('').trim();
    if (text) lines.push(text);
    if (lines.length >= 5) break;
  }
  return lines;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.NOTION_TOKEN) {
    return res.status(200).json({ available: false, reason: 'NOTION_TOKEN not set' });
  }

  const ID = process.env.TRANSCODE_PAGE_ID || DEFAULT_TRANSCODE_ID;

  try {
    // Try as a database first — that's where queue + status make sense.
    const dbRes = await fetchNotion(`/databases/${ID}`);
    if (dbRes.ok) {
      const q = await fetchNotion(`/databases/${ID}/query`, {
        method: 'POST',
        body: JSON.stringify({ page_size: 50 }),
      });
      if (!q.ok) {
        return res.status(200).json({ available: false, reason: `db query ${q.status}` });
      }
      const rows = (q.body.results || []).map(p => ({
        title: titleText(p.properties),
        status: statusText(p.properties),
        last_edited: p.last_edited_time,
      }));

      const encoding = rows.find(r => bucket(r.status) === 'encoding') || null;
      const queue = rows.filter(r => bucket(r.status) === 'queued');
      const done = rows
        .filter(r => bucket(r.status) === 'done')
        .sort((a, b) => (b.last_edited || '').localeCompare(a.last_edited || ''));

      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
      return res.status(200).json({
        available: true,
        source: 'db',
        encoding: encoding ? { title: encoding.title, status: encoding.status } : null,
        queueCount: queue.length,
        lastCompleted: done[0] ? { title: done[0].title } : null,
      });
    }

    // Fall back to page: read title + first few text blocks
    const pageRes = await fetchNotion(`/pages/${ID}`);
    if (!pageRes.ok) {
      return res.status(200).json({ available: false, reason: `page ${pageRes.status}` });
    }
    const title = titleText(pageRes.body.properties || {});
    const lines = await readBlocks(ID);

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({
      available: true,
      source: 'page',
      title,
      lines,
    });
  } catch (err) {
    console.error('transcode error:', err);
    return res.status(200).json({ available: false, reason: err.message || 'fetch failed' });
  }
};
