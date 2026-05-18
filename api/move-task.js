// Vercel Serverless Function — move a To-Do task into another database
// POST /api/move-task
//   body: { taskId, target: "buy" | "visit", name, notes?, clientDate? }
//
// Creates an entry in the target DB with Name + Notes, then marks the
// original task Done. Target DB IDs come from env vars:
//   TO_BUY_DB_ID   (placeholder — set once the DB exists)
//   TO_VISIT_DB_ID (placeholder — set once the DB exists)
//
// Returns { success: true, targetUrl } or { success: false, error }.

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const TARGETS = {
  buy:   { envVar: 'TO_BUY_DB_ID',   label: 'To Buy' },
  visit: { envVar: 'TO_VISIT_DB_ID', label: 'To Visit' },
};

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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  if (!process.env.NOTION_TOKEN) {
    return res.status(500).json({ success: false, error: 'NOTION_TOKEN not set' });
  }

  const { taskId, target, name, notes, clientDate } = req.body || {};
  if (!taskId) return res.status(400).json({ success: false, error: 'taskId is required' });
  if (!name?.trim()) return res.status(400).json({ success: false, error: 'name is required' });

  const cfg = TARGETS[target];
  if (!cfg) {
    return res.status(400).json({ success: false, error: `unknown target "${target}"` });
  }
  const targetDbId = process.env[cfg.envVar];
  if (!targetDbId) {
    return res.status(200).json({
      success: false,
      error: `${cfg.label} database not configured yet — set ${cfg.envVar} in Vercel env`,
    });
  }

  try {
    const properties = {
      'Name': { title: [{ text: { content: name.trim() } }] },
    };
    if (notes?.trim()) {
      properties['Notes'] = { rich_text: [{ text: { content: notes.trim().slice(0, 2000) } }] };
    }

    const newPage = await fetchNotion('/pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { database_id: targetDbId },
        properties,
      }),
    });

    // Mark original task Done — only after the new entry succeeded
    const today = clientDate || new Date().toISOString().split('T')[0];
    await fetchNotion(`/pages/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        properties: {
          'Status': { status: { name: 'Done' } },
          'Date Completed': { date: { start: today } },
        },
      }),
    });

    return res.status(200).json({
      success: true,
      target,
      targetLabel: cfg.label,
      targetUrl: newPage.url,
    });
  } catch (err) {
    console.error('move-task error:', err);
    return res.status(200).json({ success: false, error: err.message || 'Internal server error' });
  }
};
