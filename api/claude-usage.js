// Vercel serverless proxy for Anthropic Usage & Cost Admin API
// Requires an Admin API key (sk-ant-admin...) passed via x-api-key header

module.exports = async function handler(req, res) {
  // CORS headers — allow the Vercel deployment to call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-api-key, content-type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing x-api-key header. Provide an Anthropic Admin API key.' });
  }

  // Which sub-endpoint to hit: 'usage' (default) or 'cost'
  const { endpoint = 'usage', ...rest } = req.query;

  let anthropicUrl;
  if (endpoint === 'cost') {
    anthropicUrl = 'https://api.anthropic.com/v1/organizations/cost_report';
  } else {
    anthropicUrl = 'https://api.anthropic.com/v1/organizations/usage_report/messages';
  }

  // Forward all remaining query params as-is
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(rest)) {
    if (Array.isArray(value)) {
      value.forEach(v => params.append(key, v));
    } else {
      params.append(key, value);
    }
  }

  const fullUrl = `${anthropicUrl}?${params.toString()}`;

  try {
    const upstream = await fetch(fullUrl, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: data?.error?.message || 'Upstream API error',
        details: data,
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('claude-usage proxy error:', err);
    return res.status(500).json({ error: 'Internal proxy error', message: err.message });
  }
}
