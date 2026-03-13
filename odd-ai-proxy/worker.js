// ═══════════════════════════════════════════════════════════
// ODD AI — Cloudflare Worker Proxy (Anthropic + Notion + Meta + Higgsfield)
// ═══════════════════════════════════════════════════════════
// Routes:
//   POST /           → Anthropic Claude API proxy
//   GET  /notion/*    → Notion API proxy
//   POST /notion/*    → Notion API proxy
//   GET  /meta/*      → Meta Graph API proxy
//   POST /higgs/*     → Higgsfield API proxy
//   GET  /higgs/*     → Higgsfield API proxy (polling)
// ═══════════════════════════════════════════════════════════

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, x-notion-key, x-meta-token, x-higgs-key',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── Meta Graph API Proxy ──
    if (url.pathname.startsWith('/meta/')) {
      return handleMeta(request, url);
    }

    // ── Higgsfield API Proxy ──
    if (url.pathname.startsWith('/higgs/')) {
      return handleHiggs(request, url);
    }

    // ── Notion API Proxy ──
    if (url.pathname.startsWith('/notion/')) {
      return handleNotion(request, url);
    }

    // ── Anthropic API Proxy (default) ──
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const body = await request.text();
      const apiKey = request.headers.get('x-api-key');
      if (!apiKey) return corsJson({ error: 'Missing API key' }, 401);

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body,
      });

      const responseHeaders = new Headers();
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Content-Type', resp.headers.get('Content-Type') || 'application/json');

      return new Response(resp.body, { status: resp.status, headers: responseHeaders });
    } catch (err) {
      return corsJson({ error: err.message }, 500);
    }
  },
};

// ── Meta Graph API proxy handler ──
async function handleMeta(request, url) {
  const metaToken = request.headers.get('x-meta-token');
  if (!metaToken) return corsJson({ error: 'Missing Meta access token' }, 401);

  // /meta/act_123/ads → https://graph.facebook.com/v21.0/act_123/ads
  const metaPath = url.pathname.replace('/meta/', '');
  const metaUrl = 'https://graph.facebook.com/v21.0/' + metaPath + url.search +
    (url.search ? '&' : '?') + 'access_token=' + encodeURIComponent(metaToken);

  try {
    const resp = await fetch(metaUrl, {
      method: request.method,
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await resp.text();

    return new Response(data, {
      status: resp.status,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return corsJson({ error: 'Meta proxy error: ' + err.message }, 500);
  }
}

// ── Notion proxy handler ──
async function handleNotion(request, url) {
  const notionKey = request.headers.get('x-notion-key');
  if (!notionKey) return corsJson({ error: 'Missing Notion key' }, 401);

  // /notion/blocks/xxx/children → https://api.notion.com/v1/blocks/xxx/children
  const notionPath = url.pathname.replace('/notion/', '');
  const notionUrl = 'https://api.notion.com/v1/' + notionPath + url.search;

  try {
    const opts = {
      method: request.method,
      headers: {
        'Authorization': 'Bearer ' + notionKey,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
    };
    if (request.method === 'POST') {
      opts.body = await request.text();
    }

    const resp = await fetch(notionUrl, opts);
    const data = await resp.text();

    return new Response(data, {
      status: resp.status,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return corsJson({ error: 'Notion proxy error: ' + err.message }, 500);
  }
}

// ── Higgsfield proxy handler ──
async function handleHiggs(request, url) {
  const higgsKey = request.headers.get('x-higgs-key');
  if (!higgsKey) return corsJson({ error: 'Missing Higgsfield key' }, 401);

  // /higgs/flux-pro/kontext/max/text-to-image → https://platform.higgsfield.ai/flux-pro/kontext/max/text-to-image
  const higgsPath = url.pathname.replace('/higgs/', '');
  const higgsUrl = 'https://platform.higgsfield.ai/' + higgsPath + url.search;

  try {
    const opts = {
      method: request.method,
      headers: {
        'Authorization': 'Key ' + higgsKey,
        'Content-Type': 'application/json',
      },
    };
    if (request.method === 'POST') {
      opts.body = await request.text();
    }

    const resp = await fetch(higgsUrl, opts);
    const data = await resp.text();

    return new Response(data, {
      status: resp.status,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': resp.headers.get('Content-Type') || 'application/json' },
    });
  } catch (err) {
    return corsJson({ error: 'Higgsfield proxy error: ' + err.message }, 500);
  }
}

function corsJson(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
  });
}
