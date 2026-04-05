// Vercel Serverless Function — Notion Task API Proxy
// Endpoints:
//   GET  /api/tasks         → fetch today's + overdue tasks
//   POST /api/tasks         → create a new task
//   PATCH /api/tasks?id=ID  → mark task complete

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

function mapPage(page) {
  const props = page.properties;
  const dueStart = props['Due Date']?.date?.start || null;
  const today = new Date().toISOString().split('T')[0];
  const isOverdue = dueStart && dueStart < today;

  return {
    id: page.id,
    url: page.url,
    name: props['Name']?.title?.map(t => t.plain_text).join('') || 'Untitled',
    status: props['Status 1']?.status?.name || '',
    dueDate: dueStart,
    isOverdue,
    priority: props['Priority']?.select?.name || '',
    project: (props['Project']?.multi_select || []).map(p => p.name),
    notes: props['Notes']?.rich_text?.map(t => t.plain_text).join('') || '',
    dateCompleted: props['Date Completed']?.date?.start || null,
  };
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const DATABASE_ID = process.env.NOTION_DATABASE_ID;
  if (!DATABASE_ID) return res.status(500).json({ error: 'NOTION_DATABASE_ID not set' });
  if (!process.env.NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN not set' });

  try {
    // ─── GET /api/tasks ───────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const today = new Date().toISOString().split('T')[0];

      const data = await fetchNotion(`/databases/${DATABASE_ID}/query`, {
        method: 'POST',
        body: JSON.stringify({
          filter: {
            and: [
              {
                property: 'Status 1',
                status: { does_not_equal: 'Done' },
              },
              {
                property: 'Due Date',
                date: { on_or_before: today },
              },
            ],
          },
          sorts: [
            { property: 'Priority', direction: 'ascending' },
            { property: 'Due Date', direction: 'ascending' },
          ],
          page_size: 100,
        }),
      });

      const tasks = (data.results || []).map(mapPage);

      // Separate today vs overdue for stats
      const todayTasks = tasks.filter(t => t.dueDate === today);
      const overdueTasks = tasks.filter(t => t.dueDate && t.dueDate < today);

      return res.status(200).json({
        tasks,
        stats: {
          today: todayTasks.length,
          overdue: overdueTasks.length,
          total: tasks.length,
        },
      });
    }

    // ─── POST /api/tasks ──────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const { name, dueDate, priority, project, notes } = req.body || {};

      if (!name?.trim()) return res.status(400).json({ error: 'Task name is required' });

      const properties = {
        'Name': { title: [{ text: { content: name.trim() } }] },
        'Status 1': { status: { name: 'Not started' } },
      };

      if (dueDate) properties['Due Date'] = { date: { start: dueDate } };
      if (priority) properties['Priority'] = { select: { name: priority } };
      if (project?.length) properties['Project'] = { multi_select: project.map(p => ({ name: p })) };
      if (notes?.trim()) properties['Notes'] = { rich_text: [{ text: { content: notes.trim() } }] };

      const page = await fetchNotion('/pages', {
        method: 'POST',
        body: JSON.stringify({
          parent: { database_id: DATABASE_ID },
          properties,
        }),
      });

      return res.status(201).json(mapPage(page));
    }

    // ─── PATCH /api/tasks?id=ID ───────────────────────────────────────────────
    if (req.method === 'PATCH') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Task id is required' });

      const today = new Date().toISOString().split('T')[0];

      const page = await fetchNotion(`/pages/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          properties: {
            'Status 1': { status: { name: 'Done' } },
            'Date Completed': { date: { start: today } },
          },
        }),
      });

      return res.status(200).json(mapPage(page));
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('API error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
