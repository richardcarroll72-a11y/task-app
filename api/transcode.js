// Vercel Serverless Function — recent transcodes
// GET /api/transcode
//
// Reads the Notion "Transcode Log" database (or a page) configured via
// TRANSCODE_PAGE_ID. The transcode pipeline itself runs on a VM; Notion
// only stores the post-hoc log, so this surfaces recent completed encodes
// rather than live queue/encoding state.
//
// Response shapes:
//   { available: true, source: 'log',  recent: [...], total }
//   { available: true, source: 'page', title, lines: [string, ...] }
//   { available: false, reason }

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const DEFAULT_TRANSCODE_ID = 'b87c6d06d5e84a65913b9d45c811804f';
const RECENT_LIMIT = 5;

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

function plainText(prop) {
  if (!prop) return '';
  const arr = prop.rich_text || prop.title || [];
  return arr.map(t => t.plain_text || '').join('').trim();
}

function titleText(props) {
  for (const v of Object.values(props || {})) {
    if (v?.type === 'title') return plainText(v);
  }
  return '';
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
    const dbRes = await fetchNotion(`/databases/${ID}`);
    if (dbRes.ok) {
      const q = await fetchNotion(`/databases/${ID}/query`, {
        method: 'POST',
        body: JSON.stringify({ page_size: 50 }),
      });
      if (!q.ok) {
        return res.status(200).json({ available: false, reason: `db query ${q.status}` });
      }
      const rows = (q.body.results || []).map(p => {
        const props = p.properties || {};
        const show = plainText(props['Show / Movie']);
        return {
          title: titleText(props) || show || '—',
          date: props.Date?.date?.start || null,
          savings: props['Savings %']?.number ?? null,
          vm: props.VM?.select?.name || null,
          showMovie: show || null,
          _sortKey: props.Date?.date?.start || p.created_time || '',
        };
      });
      rows.sort((a, b) => (b._sortKey || '').localeCompare(a._sortKey || ''));
      const recent = rows.slice(0, RECENT_LIMIT).map(({ _sortKey, ...rest }) => rest);

      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
      return res.status(200).json({
        available: true,
        source: 'log',
        recent,
        total: rows.length,
      });
    }

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
