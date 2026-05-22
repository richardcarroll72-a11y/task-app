// Vercel Serverless Function — cross-section task counts
// GET /api/stats?clientDate=YYYY-MM-DD
//
// Returns counts the main /api/tasks view can't compute (it only returns
// today/overdue). Used by the reading queue counter and KIT badge.
//
// {
//   readBacklog:           number,  // active "Read:" tasks (Status ≠ Done)
//   readCompletedThisWeek: number,  // "Read:" tasks marked Done since Monday
//   kitReachOut:           number,  // active "Reach out to " tasks
// }

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

// Returns Monday of the week containing the given YYYY-MM-DD (Mon = week start).
function startOfWeek(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dow = date.getDay(); // 0 = Sun, 1 = Mon, ...
  const daysSinceMonday = (dow + 6) % 7;
  date.setDate(date.getDate() - daysSinceMonday);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Count results by paging through Notion query results.
async function countQuery(dbId, filter) {
  let total = 0;
  let cursor = undefined;
  do {
    const body = { filter, page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await fetchNotion(`/databases/${dbId}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    total += (data.results || []).length;
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return total;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const DB_ID = process.env.NOTION_DATABASE_ID;
  if (!DB_ID) return res.status(500).json({ error: 'NOTION_DATABASE_ID not set' });
  if (!process.env.NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN not set' });

  const today = req.query.clientDate || new Date().toISOString().split('T')[0];
  const weekStart = startOfWeek(today);

  try {
    const [readBacklog, readCompletedThisWeek, kitReachOut] = await Promise.all([
      countQuery(DB_ID, {
        and: [
          { property: 'Status', status: { does_not_equal: 'Done' } },
          { property: 'Name', title: { starts_with: 'Read:' } },
        ],
      }),
      countQuery(DB_ID, {
        and: [
          { property: 'Status', status: { equals: 'Done' } },
          { property: 'Name', title: { starts_with: 'Read:' } },
          { property: 'Date Completed', date: { on_or_after: weekStart } },
        ],
      }),
      countQuery(DB_ID, {
        and: [
          { property: 'Status', status: { does_not_equal: 'Done' } },
          { property: 'Name', title: { starts_with: 'Reach out to ' } },
        ],
      }),
    ]);

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    return res.status(200).json({ readBacklog, readCompletedThisWeek, kitReachOut, weekStart });
  } catch (err) {
    console.error('stats error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
