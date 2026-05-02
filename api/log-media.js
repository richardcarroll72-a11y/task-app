// Vercel Serverless Function — Media Log → Notion (+ Discogs collection)
// POST /api/log-media
//   body: {
//     type:        "book" | "vinyl",
//     title:       string,
//     author?:     string,            // for books
//     artist?:     string,            // for vinyl
//     status:      "started" | "finished",
//     barcode?:    string,
//     cover?:      string,            // optional cover image URL
//     year?:       string | number,
//     releaseId?:  number | string,   // Discogs release id (vinyl only)
//   }
//
// Required env vars:
//   NOTION_TOKEN       — already set for the task app
//   MEDIA_LOG_DB_ID    — the "📺 Media Log" database ID. Find it by opening the
//                        DB in Notion and copying the 32-char hex from the URL:
//                        https://www.notion.so/<workspace>/<DB_ID>?v=...
//   DISCOGS_TOKEN      — used to add vinyl entries to the user's collection
//   DISCOGS_USERNAME   — defaults to "richardcarroll72". Folder 1 = Uncategorized.
//
// SPIRE convention (matches Notion Media Log DB):
//   Books → "I — Intellectual"
//   Vinyl → "E — Emotional"

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

// POST /users/{username}/collection/folders/1/releases/{release_id}
// Folder 1 is the default "Uncategorized" collection.
// Returns { ok, instanceId? } on success or { ok: false, error } on failure.
// Never throws — caller decides whether to surface the error.
async function addToDiscogsCollection(releaseId) {
  const token = process.env.DISCOGS_TOKEN;
  const username = process.env.DISCOGS_USERNAME || 'richardcarroll72';
  if (!token) return { ok: false, error: 'DISCOGS_TOKEN not set' };
  if (!releaseId) return { ok: false, error: 'no releaseId' };

  try {
    const url = `https://api.discogs.com/users/${encodeURIComponent(username)}/collection/folders/1/releases/${encodeURIComponent(releaseId)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Discogs token=${token}`,
        'User-Agent': 'CoworkApp/1.0',
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `Discogs ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, instanceId: data.instance_id || null };
  } catch (err) {
    return { ok: false, error: err.message || 'Discogs request failed' };
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN not set' });
  const DB_ID = process.env.MEDIA_LOG_DB_ID;
  if (!DB_ID) return res.status(500).json({ error: 'MEDIA_LOG_DB_ID not set' });

  try {
    const body = req.body || {};
    const { type, title, author, artist, status, barcode, cover, year, releaseId } = body;

    if (!title?.trim()) return res.status(400).json({ error: 'title required' });
    if (type !== 'book' && type !== 'vinyl') return res.status(400).json({ error: 'type must be "book" or "vinyl"' });
    if (status !== 'started' && status !== 'finished') return res.status(400).json({ error: 'status must be "started" or "finished"' });

    const creator = type === 'book' ? (author || '') : (artist || '');
    const typeLabel = type === 'book' ? 'Book' : 'Vinyl';
    const statusLabel = status === 'started' ? 'Started' : 'Finished';
    const spireValue = type === 'book' ? 'I — Intellectual' : 'E — Emotional';

    // Build Notes: combine creator (Author/Artist) and status
    let notesContent = statusLabel;
    if (creator.trim()) {
      const creatorLabel = type === 'book' ? 'Author' : 'Artist';
      notesContent += ` — ${creatorLabel}: ${creator.trim()}`;
    }

    const properties = {
      'Name': { title: [{ text: { content: title.trim() } }] },
      'Type': { select: { name: typeLabel } },
      'SPIRE': { select: { name: spireValue } },
      'Date': { date: { start: new Date().toISOString().split('T')[0] } },
      'Notes': { rich_text: [{ text: { content: notesContent } }] },
    };

    // Set the page payload
    const pagePayload = {
      parent: { database_id: DB_ID },
      properties,
    };

    const page = await fetchNotion('/pages', {
      method: 'POST',
      body: JSON.stringify(pagePayload),
    });

    // For vinyl, also add the release to the user's Discogs collection.
    // Failure here must NOT block the Notion log — surface it in the response.
    let discogs = null;
    if (type === 'vinyl' && releaseId) {
      discogs = await addToDiscogsCollection(releaseId);
    }

    return res.status(201).json({
      ok: true,
      id: page.id,
      url: page.url,
      discogs,
    });
  } catch (err) {
    console.error('log-media error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
