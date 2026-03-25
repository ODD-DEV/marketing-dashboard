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
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, x-notion-key, x-meta-token, x-higgs-key, x-shopify-token',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── Shopify OAuth Callback ──
    if (url.pathname === '/shopify/callback') {
      return handleShopifyCallback(request, url);
    }

    // ── Shopify Admin API Proxy ──
    if (url.pathname.startsWith('/shopify/')) {
      return handleShopify(request, url);
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
        'Accept': 'application/json',
      },
    };
    if (request.method === 'POST') {
      opts.headers['Content-Type'] = 'application/json';
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

// ── Shopify OAuth callback handler ──
// OAuth flow: user authorizes → Shopify redirects here with ?code=xxx → we exchange for access_token
async function handleShopifyCallback(request, url) {
  const code = url.searchParams.get('code');
  const shop = url.searchParams.get('shop') || 'shop-odd-us.myshopify.com';
  const state = url.searchParams.get('state');

  if (!code) return corsJson({ error: 'Missing authorization code' }, 400);

  // Exchange code for permanent access token
  const CLIENT_ID = 'ff7ae470a227c011d81fbefdfb45f7df';
  const CLIENT_SECRET = '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';

  try {
    const resp = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
      }),
    });

    const data = await resp.json();

    if (data.access_token) {
      // 성공 — 토큰을 화면에 표시 (1회용, 사용자가 복사해서 config에 저장)
      return new Response(
        `<html><body style="font-family:monospace;background:#111;color:#0f0;padding:40px">` +
        `<h2>Shopify OAuth 성공!</h2>` +
        `<p>Access Token:</p>` +
        `<pre style="background:#222;padding:20px;border-radius:8px;font-size:18px;color:#4ade80">${data.access_token}</pre>` +
        `<p>Scope: ${data.scope || 'N/A'}</p>` +
        `<p style="color:#f59e0b">이 토큰을 erp_config.json의 "shopify_access_token"에 저장하세요.</p>` +
        `</body></html>`,
        { status: 200, headers: { 'Content-Type': 'text/html' } }
      );
    } else {
      return new Response(
        `<html><body style="font-family:monospace;background:#111;color:#f00;padding:40px">` +
        `<h2>OAuth 실패</h2><pre>${JSON.stringify(data, null, 2)}</pre></body></html>`,
        { status: 400, headers: { 'Content-Type': 'text/html' } }
      );
    }
  } catch (err) {
    return corsJson({ error: 'Shopify OAuth error: ' + err.message }, 500);
  }
}

// ── Shopify Admin API proxy handler ──
async function handleShopify(request, url) {
  const shopifyToken = request.headers.get('x-shopify-token');
  if (!shopifyToken) return corsJson({ error: 'Missing Shopify access token' }, 401);

  const shop = 'shop-odd-us.myshopify.com';
  const shopifyPath = url.pathname.replace('/shopify/', '');
  const shopifyUrl = `https://${shop}/admin/api/2025-01/${shopifyPath}${url.search}`;

  try {
    const opts = {
      method: request.method,
      headers: {
        'X-Shopify-Access-Token': shopifyToken,
        'Content-Type': 'application/json',
      },
    };
    if (request.method === 'POST' || request.method === 'PUT') {
      opts.body = await request.text();
    }

    const resp = await fetch(shopifyUrl, opts);
    const data = await resp.text();

    const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    // Forward pagination Link header
    const link = resp.headers.get('Link');
    if (link) headers['X-Shopify-Link'] = link;

    return new Response(data, { status: resp.status, headers });
  } catch (err) {
    return corsJson({ error: 'Shopify proxy error: ' + err.message }, 500);
  }
}

function corsJson(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
  });
}
