// Vercel Serverless Function — Move article task to another Notion DB
// POST /api/move-article
//   body: {
//     taskId:      string   — Notion page ID of the original task to mark Done
//     taskName:    string   — article title (without "Read: " prefix)
//     articleUrl:  string?  — URL of the article
//     destination: string   — one of: "to-visit" | "to-buy" | "future-projects"
//     clientDate:  string?  — YYYY-MM-DD for Date Completed (falls back to UTC today)
//   }
//
// Required env vars:
//   NOTION_TOKEN              — shared with task app
//   NOTION_DATABASE_ID        — task DB (for marking Done)
//   TO_VISIT_DB_ID            — 📍 To Visit database
//   TO_BUY_DB_ID              — 🛒 To Buy database
//   NOTION_FUTURE_PROJECTS_DB_ID — 🚀 Future Projects (falls back to hardcoded ID)
//
// Each destination DB is assumed to have at least:
//   Name  (title property)
// Optionally:
//   URL   (url property) — included when present; gracefully skipped if not
//   Notes (rich_text)    — always written; includes source URL as fallback

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const DESTINATIONS = {
  'to-visit': {
    envVar: 'TO_VISIT_DB_ID',
    label: 'To Visit',
  },
  'to-buy': {
    envVar: 'TO_BUY_DB_ID',
    label: 'To Buy',
  },
  'future-projects': {
    envVar: 'NOTION_FUTURE_PROJECTS_DB_ID',
    defaultId: '77e3d9c04649418198ec557854ebecd3',
    label: 'Future Projects',
  },
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

// Attempt to create a page; if a property is rejected (e.g. "URL" doesn't exist
// in the target DB), retry with that property omitted and the URL folded into Notes.
async function createDestPage(dbId, taskName, articleUrl) {
  const name = (taskName || 'Untitled').trim();
  const notesText = articleUrl
    ? `Source: ${articleUrl}`
    : `Moved from article queue`;

  const baseProperties = {
    'Name': { title: [{ text: { content: name } }] },
    'Notes': { rich_text: [{ text: { content: notesText } }] },
  };

  // Try with URL property first
  if (articleUrl) {
    try {
      return await fetchNotion('/pages', {
        method: 'POST',
        body: JSON.stringify({
          parent: { database_id: dbId },
          properties: { ...baseProperties, 'URL': { url: articleUrl } },
        }),
      });
    } catch (err) {
      // If the error mentions URL or validation, retry without it
      const msg = err.message || '';
      if (!msg.includes('URL') && !msg.includes('url') && !msg.includes('property') && !msg.includes('validation')) {
        throw err;
      }
      // fall through to retry without URL property
    }
  }

  // Retry / initial attempt without URL property
  return fetchNotion('/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { database_id: dbId },
      properties: baseProperties,
    }),
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  if (!process.env.NOTION_TOKEN) {
    return res.status(500).json({ success: false, error: 'NOTION_TOKEN not set' });
  }

  const { taskId, taskName, articleUrl, destination, clientDate } = req.body || {};

  if (!taskId) {
    return res.status(400).json({ success: false, error: 'taskId is required' });
  }
  if (!destination || !DESTINATIONS[destination]) {
    return res.status(400).json({
      success: false,
      error: `destination must be one of: ${Object.keys(DESTINATIONS).join(', ')}`,
    });
  }

  const dest = DESTINATIONS[destination];
  const dbId = process.env[dest.envVar] || dest.defaultId;
  if (!dbId) {
    return res.status(500).json({
      success: false,
      error: `${dest.envVar} environment variable is not set`,
    });
  }

  try {
    // Step 1: Create entry in destination DB (if this fails, task stays active)
    const destPage = await createDestPage(dbId, taskName, articleUrl);

    // Step 2: Mark original task Done
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

    return res.status(200).json({ success: true, destUrl: destPage.url });
  } catch (err) {
    console.error('move-article error:', err);
    return res.status(200).json({ success: false, error: err.message || 'Internal server error' });
  }
};
