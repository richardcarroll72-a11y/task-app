// Vercel Serverless Function — Barcode Metadata Lookup
// GET /api/lookup-barcode?barcode=XXXXXXXXXXXXX
//
// • Barcodes starting 978/979 → ISBN (book) → Open Library
//     https://openlibrary.org/api/books?bibkeys=ISBN:XXXX&format=json&jscmd=data
// • Anything else → UPC (vinyl) → Discogs
//     https://api.discogs.com/database/search?barcode=XXXX&token=TOKEN
//
// Required env var:
//   DISCOGS_TOKEN = ogrpfsoENgttiAjuRGANsBbNoKaQBcVRBXbgrmNi
//   (Vercel → Project → Settings → Environment Variables)

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const barcode = (req.query.barcode || '').toString().trim();
  if (!barcode) return res.status(400).json({ error: 'barcode query param required' });

  try {
    // ── Book (ISBN-13) ─────────────────────────────────────────────────────
    if (barcode.startsWith('978') || barcode.startsWith('979')) {
      const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(barcode)}&format=json&jscmd=data`;
      const olRes = await fetch(url);
      if (!olRes.ok) throw new Error(`Open Library error ${olRes.status}`);
      const olData = await olRes.json();
      const entry = olData[`ISBN:${barcode}`];

      if (!entry) {
        return res.status(404).json({
          type: 'book',
          barcode,
          found: false,
          error: 'No Open Library record for this ISBN',
        });
      }

      return res.status(200).json({
        type: 'book',
        barcode,
        found: true,
        title: entry.title || 'Unknown title',
        author: (entry.authors || []).map(a => a.name).join(', ') || 'Unknown author',
        cover: entry.cover?.medium || `https://covers.openlibrary.org/b/isbn/${barcode}-M.jpg`,
        publishDate: entry.publish_date || null,
      });
    }

    // ── Vinyl / UPC ────────────────────────────────────────────────────────
    const token = process.env.DISCOGS_TOKEN;
    if (!token) return res.status(500).json({ error: 'DISCOGS_TOKEN not set' });

    const url = `https://api.discogs.com/database/search?barcode=${encodeURIComponent(barcode)}&token=${encodeURIComponent(token)}`;
    const dRes = await fetch(url, {
      // Discogs requires a User-Agent
      headers: { 'User-Agent': 'TaskAppMediaScanner/1.0' },
    });
    if (!dRes.ok) throw new Error(`Discogs error ${dRes.status}`);
    const dData = await dRes.json();
    const first = (dData.results || [])[0];

    if (!first) {
      return res.status(404).json({
        type: 'vinyl',
        barcode,
        found: false,
        error: 'No Discogs record for this barcode',
      });
    }

    // Discogs `title` is "Artist - Album" — split on the first " - "
    const rawTitle = first.title || '';
    let artist = '';
    let album = rawTitle;
    const dashIdx = rawTitle.indexOf(' - ');
    if (dashIdx > -1) {
      artist = rawTitle.slice(0, dashIdx).trim();
      album = rawTitle.slice(dashIdx + 3).trim();
    }

    return res.status(200).json({
      type: 'vinyl',
      barcode,
      found: true,
      title: album || 'Unknown title',
      artist: artist || 'Unknown artist',
      cover: first.cover_image || first.thumb || null,
      year: first.year || null,
      releaseId: first.id || null,
    });
  } catch (err) {
    console.error('lookup-barcode error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
