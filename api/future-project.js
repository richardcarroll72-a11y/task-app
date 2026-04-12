// Vercel Serverless Function — Park task as Future Project
// POST /api/future-project

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

const VALID_SPIRE = [
  'S — Spiritual',
  'P — Physical',
  'I — Intellectual',
  'R — Relational',
  'E — Emotional',
];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  if (!process.env.NOTION_TOKEN) {
    return res.status(500).json({ success: false, error: 'NOTION_TOKEN not set' });
  }
  if (!process.env.NOTION_DATABASE_ID) {
    return res.status(500).json({ success: false, error: 'NOTION_DATABASE_ID not set' });
  }
  const FUTURE_PROJECTS_DB_ID = process.env.NOTION_FUTURE_PROJECTS_DB_ID || '77e3d9c04649418198ec557854ebecd3';

  const {
    taskId, taskName, projectName, spire, notes, taskUrl, clientDate,
    priority, project, dueDate, articleUrl,
  } = req.body || {};

  if (!taskId) return res.status(400).json({ success: false, error: 'taskId is required' });
  if (!projectName?.trim()) return res.status(400).json({ success: false, error: 'projectName is required' });
  if (!spire) return res.status(400).json({ success: false, error: 'spire is required' });
  if (!VALID_SPIRE.includes(spire)) {
    return res.status(400).json({ success: false, error: `spire must be one of: ${VALID_SPIRE.join(', ')}` });
  }

  try {
    // Build comprehensive notes combining all task metadata
    const notesLines = [];
    if (taskName) notesLines.push(`Task: ${taskName}`);
    if (priority) notesLines.push(`Priority: ${priority}`);
    if (Array.isArray(project) && project.length) notesLines.push(`Project: ${project.join(', ')}`);
    if (dueDate) notesLines.push(`Due date: ${dueDate}`);
    if (articleUrl) notesLines.push(`Article URL: ${articleUrl}`);
    if (taskUrl) notesLines.push(`Notion task: ${taskUrl}`);
    if (notes?.trim()) {
      if (notesLines.length) notesLines.push('');
      notesLines.push(notes.trim());
    }
    const fullNotes = notesLines.join('\n');

    // Step 1: Create Future Projects entry (if this fails, task is NOT marked Done)
    const fpProperties = {
      'Name': { title: [{ text: { content: projectName.trim() } }] },
      'Status': { status: { name: 'Parked 🅿️' } },
      'SPIRE': { select: { name: spire } },
    };
    if (fullNotes) fpProperties['Notes'] = { rich_text: [{ text: { content: fullNotes.slice(0, 2000) } }] };
    if (articleUrl) fpProperties['URL'] = { url: articleUrl };
    if (priority) fpProperties['Priority'] = { select: { name: priority } };
    if (Array.isArray(project) && project.length) {
      fpProperties['Project'] = { multi_select: project.map(p => ({ name: p })) };
    }
    if (dueDate) fpProperties['Due Date'] = { date: { start: dueDate.split('T')[0] } };

    const fpPage = await fetchNotion('/pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { database_id: FUTURE_PROJECTS_DB_ID },
        properties: fpProperties,
      }),
    });

    // Step 2: Mark original task Done (only runs after FP entry succeeds)
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

    return res.status(200).json({ success: true, futureProjectUrl: fpPage.url });
  } catch (err) {
    console.error('FP error details:', err?.code, err?.status, JSON.stringify(err?.body || err?.message || err));
    return res.status(200).json({ success: false, error: err.message || 'Internal server error' });
  }
};
