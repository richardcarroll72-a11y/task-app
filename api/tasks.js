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

function mapPage(page, today) {
  const props = page.properties;
  const dueStart = props['Due Date']?.date?.start || null;
  // Use date-only part for comparison so datetime strings (e.g. "2026-04-06T09:00:00+00:00") compare correctly
  const dueDateOnly = dueStart ? dueStart.split('T')[0] : null;
  const isOverdue = dueDateOnly && today && dueDateOnly < today;

  return {
    id: page.id,
    url: page.url,
    name: props['Name']?.title?.map(t => t.plain_text).join('') || 'Untitled',
    status: props['Status']?.status?.name || '',
    dueDate: dueStart,
    isOverdue,
    priority: props['Priority']?.select?.name || '',
    spire: (props['SPIRE']?.multi_select || [])
      .map(s => s.name.trim().charAt(0).toUpperCase())
      .filter(c => ['S','P','I','R','E'].includes(c)),
    project: (props['Project Link']?.relation?.[0]?.id) || null,
    notes: props['Notes']?.rich_text?.map(t => t.plain_text).join('') || '',
    articleUrl: props['URL']?.url || null,
    dateCompleted: props['Date Completed']?.date?.start || null,
    subtaskIds: (props['Subtasks']?.relation || []).map(r => r.id),
    parentId: props['Parent Task']?.relation?.[0]?.id || null,
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
      // Use the client's local date when available (passed as ?clientDate=YYYY-MM-DD)
      // so "today" reflects the user's timezone, not Vercel's UTC clock.
      // Without this, tasks due today in MDT (UTC-6) appear as "overdue" after 6 pm.
      const today = req.query.clientDate || new Date().toISOString().split('T')[0];

      const data = await fetchNotion(`/databases/${DATABASE_ID}/query`, {
        method: 'POST',
        body: JSON.stringify({
          filter: {
            and: [
              {
                property: 'Status',
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

      const tasks = (data.results || []).map(page => mapPage(page, today));

      // Fetch and attach subtasks for any parent tasks
      const parentTasks = tasks.filter(t => t.subtaskIds.length > 0);
      if (parentTasks.length > 0) {
        const allSubtaskIds = [...new Set(parentTasks.flatMap(t => t.subtaskIds))];
        const subtaskPages = await Promise.all(
          allSubtaskIds.map(id => fetchNotion(`/pages/${id}`).catch(() => null))
        );
        const subtaskMap = {};
        subtaskPages.filter(Boolean).forEach(page => {
          subtaskMap[page.id] = mapPage(page, today);
        });
        parentTasks.forEach(task => {
          task.subtasks = task.subtaskIds.map(id => subtaskMap[id]).filter(Boolean);
        });
      }

      // Remove subtasks from top-level if their parent is in the result set
      const taskIds = new Set(tasks.map(t => t.id));
      const filteredTasks = tasks.filter(t => !t.parentId || !taskIds.has(t.parentId));

      // Separate today vs overdue for stats (use date-only part to handle datetime strings)
      const todayTasks = filteredTasks.filter(t => t.dueDate && t.dueDate.split('T')[0] === today);
      const overdueTasks = filteredTasks.filter(t => t.dueDate && t.dueDate.split('T')[0] < today);

      return res.status(200).json({
        tasks: filteredTasks,
        stats: {
          today: todayTasks.length,
          overdue: overdueTasks.length,
          total: filteredTasks.length,
        },
      });
    }

    // ─── POST /api/tasks ──────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const { name, dueDate, priority, project, notes } = req.body || {};

      if (!name?.trim()) return res.status(400).json({ error: 'Task name is required' });

      const properties = {
        'Name': { title: [{ text: { content: name.trim() } }] },
        'Status': { status: { name: 'Not started' } },
      };

      if (dueDate) {
        // If a time component is present, include timezone so Notion stores it correctly
        const dateObj = { start: dueDate };
        if (dueDate.includes('T')) dateObj.time_zone = 'America/Edmonton';
        properties['Due Date'] = { date: dateObj };
      }
      if (priority) properties['Priority'] = { select: { name: priority } };
      if (project?.length) properties['Project'] = { relation: project.map(id => ({ id })) };
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
      const { id, action } = req.query;
      if (!id) return res.status(400).json({ error: 'Task id is required' });

      // ── Snooze: push Due Date to tomorrow, leave Status unchanged ──
      if (action === 'snooze') {
        const clientDate = req.query.clientDate || new Date().toISOString().split('T')[0];
        const [y, m, d] = clientDate.split('-').map(Number);
        const tomorrow = new Date(y, m - 1, d + 1);
        const newDueDate = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

        await fetchNotion(`/pages/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            properties: {
              'Due Date': { date: { start: newDueDate } },
            },
          }),
        });

        return res.status(200).json({ success: true, newDueDate });
      }

      // Use client's local date so Date Completed records the right calendar day
      const today = req.query.clientDate || new Date().toISOString().split('T')[0];

      const page = await fetchNotion(`/pages/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          properties: {
            'Status': { status: { name: 'Done' } },
            'Date Completed': { date: { start: today } },
          },
        }),
      });

      return res.status(200).json(mapPage(page, today));
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('API error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
