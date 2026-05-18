// Vercel Serverless Function — transcode status
// GET /api/transcode
//
// TRANSCODE_PAGE_ID may point at either:
//   • a Notion DATABASE → "Transcode Log" (post-hoc completed encodes)
//   • a Notion PAGE     → "Transcode Live Status" (paragraph per VM,
//     written live by the VM scripts after each encode)
//
// Response shapes:
//   { available: true, source: 'log',  recent: [...], total }
//   { available: true, source: 'live-status', vms: [...] }
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

async function readParagraphs(pageId) {
  const r = await fetchNotion(`/blocks/${pageId}/children?page_size=25`);
  if (!r.ok) return { blocks: [], ok: false };
  const blocks = [];
  for (const b of r.body.results || []) {
    if (b.type !== 'paragraph') continue;
    const rt = b.paragraph?.rich_text || [];
    const text = rt.map(x => x.plain_text || '').join('').trim();
    blocks.push({ id: b.id, text, lastEdited: b.last_edited_time || null });
  }
  return { blocks, ok: true };
}

// Parse "[VM_NAME] | Encoding: <file> | Queue: <N> remaining | Last: <show> at <ts>"
function parseStatusLine(text) {
  if (!text) return null;
  const m = text.match(/^\[([^\]]+)\]\s*\|\s*Encoding:\s*(.*?)\s*\|\s*Queue:\s*(\d+)(?:\s*remaining)?\s*\|\s*Last:\s*(.*?)\s+at\s+(.+)$/);
  if (!m) return null;
  return {
    vmName: m[1].trim(),
    currentFile: m[2].trim(),
    queueCount: parseInt(m[3], 10),
    lastCompleted: m[4].trim(),
    updatedAt: m[5].trim(),
  };
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
    const { blocks } = await readParagraphs(ID);

    const vms = [];
    const unparsed = [];
    for (const b of blocks) {
      const parsed = parseStatusLine(b.text);
      if (parsed) {
        vms.push({ ...parsed, blockUpdatedAt: b.lastEdited });
      } else if (b.text) {
        unparsed.push(b.text);
      }
    }

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');

    if (vms.length > 0) {
      return res.status(200).json({
        available: true,
        source: 'live-status',
        title,
        vms,
      });
    }

    return res.status(200).json({
      available: true,
      source: 'page',
      title,
      lines: unparsed.slice(0, 5),
    });
  } catch (err) {
    console.error('transcode error:', err);
    return res.status(200).json({ available: false, reason: err.message || 'fetch failed' });
  }
};
