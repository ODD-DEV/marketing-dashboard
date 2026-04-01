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
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, anthropic-beta, x-notion-key, x-meta-token, x-higgs-key, x-fal-key, x-gemini-key, x-shopify-token',
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
      return handleShopifyCallback(request, url, env);
    }

    // ── Shopify Admin API Proxy ──
    if (url.pathname.startsWith('/shopify/')) {
      return handleShopify(request, url);
    }

    // ── Meta Graph API Proxy ──
    if (url.pathname.startsWith('/meta/')) {
      return handleMeta(request, url);
    }

    // ── Image Upload (base64 → public URL via KV) ──
    if (url.pathname === '/upload-image' && request.method === 'POST') {
      return handleImageUpload(request, env);
    }

    // ── Uploaded Image Serve ──
    if (url.pathname.startsWith('/img/')) {
      return handleImageServe(url, env);
    }

    // ── Gemini API Proxy ──
    if (url.pathname.startsWith('/gemini/')) {
      return handleGemini(request, url, env);
    }

    // ── fal.ai Storage Upload (base64 → fal.media URL) ──
    if (url.pathname === '/fal-upload' && request.method === 'POST') {
      return handleFalUpload(request, env);
    }

    // ── fal.ai API Proxy ──
    if (url.pathname.startsWith('/fal/')) {
      return handleFal(request, url, env);
    }

    // ── Higgsfield API Proxy ──
    if (url.pathname.startsWith('/higgs/')) {
      return handleHiggs(request, url, env);
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
      let apiKey = request.headers.get('x-api-key');
      if (!apiKey || apiKey === 'USE_SERVER_KEY') apiKey = env.ANTHROPIC_KEY;
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

// ── Image Upload handler (base64 → KV → public URL) ──
async function handleImageUpload(request, env) {
  try {
    const { image } = await request.json();
    if (!image) return corsJson({ error: 'No image data' }, 400);

    // Generate unique ID
    const id = crypto.randomUUID();

    // Convert base64 data URI to binary
    const base64Data = image.split(',')[1] || image;
    const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));

    // Detect content type
    let contentType = 'image/png';
    if (image.startsWith('data:image/jpeg')) contentType = 'image/jpeg';
    else if (image.startsWith('data:image/webp')) contentType = 'image/webp';

    // Store in KV with 1 hour expiration
    await env.IMAGE_STORE.put('img_' + id, binaryData, {
      expirationTtl: 3600,
      metadata: { contentType },
    });

    const publicUrl = new URL(request.url).origin + '/img/' + id;
    return corsJson({ url: publicUrl });
  } catch (err) {
    return corsJson({ error: 'Upload failed: ' + err.message }, 500);
  }
}

// ── Image Serve handler (KV → binary response) ──
async function handleImageServe(url, env) {
  const id = url.pathname.replace('/img/', '');
  const { value, metadata } = await env.IMAGE_STORE.getWithMetadata('img_' + id, { type: 'arrayBuffer' });
  if (!value) return new Response('Not found', { status: 404 });
  return new Response(value, {
    headers: {
      'Content-Type': metadata?.contentType || 'image/png',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

// ── Gemini API proxy handler ──
async function handleGemini(request, url, env) {
  let geminiKey = request.headers.get('x-gemini-key');
  if (!geminiKey || geminiKey === 'USE_SERVER_KEY') geminiKey = env.GEMINI_KEY;
  if (!geminiKey) return corsJson({ error: 'Missing Gemini API key' }, 401);

  // /gemini/gemini-3-pro-image-preview → models/gemini-3-pro-image-preview:generateContent
  const model = url.pathname.replace('/gemini/', '');
  const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + geminiKey;

  try {
    const body = await request.text();
    const resp = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const data = await resp.text();
    return new Response(data, {
      status: resp.status,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return corsJson({ error: 'Gemini proxy error: ' + err.message }, 500);
  }
}

// ── fal.ai Storage Upload (base64 → fal.media URL) ──
async function handleFalUpload(request, env) {
  let falKey = request.headers.get('x-fal-key');
  if (!falKey || falKey === 'USE_SERVER_KEY') falKey = env.FAL_KEY;
  if (!falKey) return corsJson({ error: 'Missing fal.ai API key' }, 401);

  try {
    const { image } = await request.json();
    if (!image) return corsJson({ error: 'No image data' }, 400);

    // Parse base64 data URI
    const match = image.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
    if (!match) return corsJson({ error: 'Invalid base64 image' }, 400);

    const mimeType = match[1];
    const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    // fal.ai storage: 2-step upload via rest.fal.ai (from official @fal-ai/client SDK)
    // Step 1: Initiate upload — get presigned PUT URL + final file_url
    const fileName = `upload_${Date.now()}.${ext}`;
    const initiateResp = await fetch(
      'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Key ' + falKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content_type: mimeType, file_name: fileName }),
      }
    );

    if (!initiateResp.ok) {
      const errText = await initiateResp.text();
      return corsJson({ error: `fal.ai storage initiate failed (${initiateResp.status}): ${errText}` }, initiateResp.status);
    }

    const { upload_url, file_url } = await initiateResp.json();
    if (!upload_url) return corsJson({ error: 'fal.ai storage initiate returned no upload_url' }, 500);

    // Step 2: PUT raw binary to presigned URL (no auth — it's a signed URL)
    const putResp = await fetch(upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      body: bytes,
    });

    if (!putResp.ok) {
      const errText = await putResp.text();
      return corsJson({ error: `fal.ai storage PUT failed (${putResp.status}): ${errText}` }, putResp.status);
    }

    // file_url is the final CDN URL of the uploaded file
    if (!file_url) return corsJson({ error: 'fal.ai storage initiate returned no file_url' }, 500);
    return corsJson({ url: file_url });
  } catch (err) {
    return corsJson({ error: 'fal.ai upload error: ' + err.message }, 500);
  }
}

// ── fal.ai API proxy handler ──
async function handleFal(request, url, env) {
  // Get API key: client header > env secret
  let falKey = request.headers.get('x-fal-key');
  if (!falKey || falKey === 'USE_SERVER_KEY') falKey = env.FAL_KEY;
  if (!falKey) return corsJson({ error: 'Missing fal.ai API key' }, 401);

  // /fal/fal-ai/flux-2-pro → https://queue.fal.run/fal-ai/flux-2-pro
  const falPath = url.pathname.replace('/fal/', '');
  const falUrl = 'https://queue.fal.run/' + falPath;

  try {
    const headers = {
      'Authorization': 'Key ' + falKey,
      'Content-Type': 'application/json',
    };

    let resp;
    if (request.method === 'POST') {
      const body = await request.text();
      resp = await fetch(falUrl, { method: 'POST', headers, body });
    } else {
      // GET for polling status/results
      resp = await fetch(falUrl, { method: 'GET', headers });
    }

    const data = await resp.text();
    return new Response(data, {
      status: resp.status,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return corsJson({ error: 'fal.ai proxy error: ' + err.message }, 500);
  }
}

// ── Meta Graph API proxy handler ──
async function handleMeta(request, url) {
  const metaToken = request.headers.get('x-meta-token');
  if (!metaToken) return corsJson({ error: 'Missing Meta access token' }, 401);

  // /meta/act_123/ads → https://graph.facebook.com/v21.0/act_123/ads
  const metaPath = url.pathname.replace('/meta/', '');
  const metaUrl = 'https://graph.facebook.com/v21.0/' + metaPath + url.search +
    (url.search ? '&' : '?') + 'access_token=' + encodeURIComponent(metaToken);

  try {
    const metaOpts = {
      method: request.method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
      metaOpts.body = await request.text();
    }
    const resp = await fetch(metaUrl, metaOpts);
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
    if (request.method === 'POST' || request.method === 'PATCH' || request.method === 'DELETE') {
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
async function handleHiggs(request, url, env) {
  let higgsKey = request.headers.get('x-higgs-key');
  if (!higgsKey || higgsKey === 'USE_SERVER_KEY') higgsKey = env.HIGGS_KEY;
  if (!higgsKey) return corsJson({ error: 'Missing Higgsfield API key' }, 401);

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
async function handleShopifyCallback(request, url, env) {
  const code = url.searchParams.get('code');
  const shop = url.searchParams.get('shop') || 'shop-odd-us.myshopify.com';
  const state = url.searchParams.get('state');

  if (!code) return corsJson({ error: 'Missing authorization code' }, 400);

  // Exchange code for permanent access token
  const CLIENT_ID = 'ff7ae470a227c011d81fbefdfb45f7df';
  const CLIENT_SECRET = env.SHOPIFY_CLIENT_SECRET;

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
