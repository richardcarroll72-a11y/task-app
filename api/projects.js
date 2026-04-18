// Vercel Serverless Function — Notion Projects API Proxy
// GET /api/projects → fetch all projects from the linked Projects database

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const TODO_DB_ID = process.env.NOTION_DATABASE_ID;
  if (!TODO_DB_ID) return res.status(500).json({ error: 'NOTION_DATABASE_ID not set' });
  if (!process.env.NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN not set' });

  try {
    // Resolve Projects DB ID: env var takes priority to avoid the extra schema fetch
    let projectsDbId = process.env.NOTION_PROJECTS_DB_ID;
    if (!projectsDbId) {
      const dbSchema = await fetchNotion(`/databases/${TODO_DB_ID}`);
      projectsDbId = dbSchema.properties?.['Project Link']?.relation?.database_id;
    }
    if (!projectsDbId) return res.status(500).json({ error: 'Could not resolve Projects database ID from Project Link relation' });

    const data = await fetchNotion(`/databases/${projectsDbId}/query`, {
      method: 'POST',
      body: JSON.stringify({ page_size: 100 }),
    });

    const projects = (data.results || []).map(page => {
      const props = page.properties;
      return {
        id: page.id,
        name: props['Name']?.title?.map(t => t.plain_text).join('') || 'Untitled',
        spire: props['SPIRE']?.select?.name?.[0] || null,
        status: props['Status']?.select?.name || props['Status']?.status?.name || '',
      };
    });

    return res.status(200).json(projects);
  } catch (err) {
    console.error('Projects API error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
