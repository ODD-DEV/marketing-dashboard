// ═══════════════════════════════════════════
// ODD Pipe — Multi-Model Asset Generators
// 10 Models: 5 Image + 5 Video (all via Higgsfield + OpenAI/fal/Ideogram)
// ═══════════════════════════════════════════

const AI_PROXY = 'https://odd-ai-proxy.it-751.workers.dev';

// ── Key accessors ──
// Keys are optional on client side — Worker proxy has env variable fallbacks
const keys = {
  higgs:    () => localStorage.getItem('odd_higgs_key') || 'USE_SERVER_KEY',
  gemini:   () => localStorage.getItem('odd_gemini_key') || 'USE_SERVER_KEY',
  openai:   () => localStorage.getItem('odd_openai_key') || 'USE_SERVER_KEY',
  fal:      () => localStorage.getItem('odd_fal_key') || 'USE_SERVER_KEY',
  ideogram: () => localStorage.getItem('odd_ideogram_key') || 'USE_SERVER_KEY',
};

// ── Aspect ratio mappers (MAX resolution per model) ──
function gptImageSize(ar) {
  return { '9:16': '1024x1536', '1:1': '1024x1024', '16:9': '1536x1024', '4:5': '1024x1280' }[ar] || '1024x1024';
}
function ideogramAspect(ar) {
  return { '9:16': 'ASPECT_9_16', '1:1': 'ASPECT_1_1', '16:9': 'ASPECT_16_9', '4:5': 'ASPECT_4_5' }[ar] || 'ASPECT_1_1';
}
// FLUX Max: custom dimensions up to 4MP (2048px max side)
function falImageSize(ar) {
  return { '9:16': { width: 1152, height: 2048 }, '1:1': { width: 2048, height: 2048 }, '16:9': { width: 2048, height: 1152 }, '4:5': { width: 1824, height: 2280 } }[ar] || { width: 2048, height: 2048 };
}

// Resolution display map — used by UI to show current output size
export const MODEL_RESOLUTIONS = {
  'nano-banana-pro': {
    type: 'image', tier: '4K',
    sizes: { '9:16': '2304×4096', '1:1': '4096×4096', '16:9': '4096×2304', '4:5': '3280×4096' }
  },
  'flux-max': {
    type: 'image', tier: '2K',
    sizes: { '9:16': '1152×2048', '1:1': '2048×2048', '16:9': '2048×1152', '4:5': '1824×2280' }
  },
  'flux-kontext': {
    type: 'image', tier: '1K',
    sizes: { '9:16': '576×1024', '1:1': '1024×1024', '16:9': '1024×576', '4:5': '912×1140' }
  },
  'reve': {
    type: 'image', tier: '1K',
    sizes: { '9:16': '576×1024', '1:1': '1024×1024', '16:9': '1024×576', '4:5': '896×1120' }
  },
  'veo3.1': {
    type: 'video', tier: '1080p',
    sizes: { '9:16': '1080×1920', '16:9': '1920×1080' }
  },
  'veo3.1-fast': {
    type: 'video', tier: '720p',
    sizes: { '9:16': '720×1280', '16:9': '1280×720' }
  },
  'seedance2': {
    type: 'video', tier: '720p',
    sizes: { '9:16': '720×1280', '1:1': '720×720', '16:9': '1280×720', '4:5': '720×900' }
  },
  'kling': {
    type: 'video', tier: '1080p',
    sizes: { '9:16': '1080×1920', '1:1': '1080×1080', '16:9': '1920×1080' }
  },
  'sora2': {
    type: 'video', tier: '1080p',
    sizes: { '9:16': '1024×1792', '16:9': '1792×1024' }
  },
  'flux-2-pro': {
    type: 'image', tier: '2K',
    sizes: { '9:16': '1152×2048', '1:1': '2048×2048', '16:9': '2048×1152', '4:5': '1824×2280' }
  },
  'seedream': {
    type: 'image', tier: '2K',
    sizes: { '9:16': '1152×2048', '1:1': '2048×2048', '16:9': '2048×1152', '4:5': '1824×2280' }
  },
};

// ═══════════════════════════════════════════
// Reference Image Resolution
// Higgsfield (fal.ai) accepts base64 data URIs directly in image_url fields.
// If that fails, we upload via Worker proxy as Plan B.
// ═══════════════════════════════════════════
async function resolveRefImage(refInput) {
  if (!refInput) return null;

  // If it's already a URL, use as-is
  if (refInput.startsWith('http://') || refInput.startsWith('https://')) {
    console.log('[RefImage] Using URL directly:', refInput.substring(0, 80));
    return refInput;
  }

  // Base64 data URI — pass directly (Higgsfield/fal.ai supports base64 data URIs)
  if (refInput.startsWith('data:')) {
    console.log('[RefImage] Passing base64 data URI directly (length:', refInput.length, ')');
    return refInput;
  }

  console.warn('[RefImage] Unknown format, passing as-is');
  return refInput;
}

// Upload image to fal.ai storage — direct presigned upload (fast, no base64 through proxy)
async function uploadToFalStorage(base64DataUri) {
  try {
    // Parse base64 data URI
    const match = base64DataUri.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
    if (!match) { console.warn('[RefImage] Invalid base64 format'); return null; }
    const mimeType = match[1];
    const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    const fileName = `upload_${Date.now()}.${ext}`;

    // Step 1: Get presigned URL from proxy (lightweight, no image data)
    console.log('[RefImage] Getting presigned upload URL...');
    const initR = await fetch(AI_PROXY + '/fal-upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-fal-key': keys.fal() },
      body: JSON.stringify({ content_type: mimeType, file_name: fileName }),
    });
    if (!initR.ok) throw new Error('presigned URL failed: ' + initR.status);
    const { upload_url, file_url } = await initR.json();
    if (!upload_url || !file_url) throw new Error('No upload_url in response');

    // Step 2: Direct PUT to fal.ai storage (binary, bypasses proxy)
    console.log('[RefImage] Direct uploading to fal.ai storage...');
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const putR = await fetch(upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      body: bytes,
    });
    if (!putR.ok) throw new Error('PUT upload failed: ' + putR.status);

    console.log('[RefImage] Uploaded to fal.ai storage:', file_url.substring(0, 80));
    return file_url;
  } catch (e) {
    console.warn('[RefImage] Direct upload failed, falling back to proxy:', e.message);
    // Fallback: old proxy method
    return uploadToFalStorageViaProxy(base64DataUri);
  }
}

// Fallback: full base64 upload through proxy (slow but reliable)
async function uploadToFalStorageViaProxy(base64DataUri) {
  try {
    console.log('[RefImage] Fallback: uploading via proxy...');
    const r = await fetch(AI_PROXY + '/fal-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-fal-key': keys.fal() },
      body: JSON.stringify({ image: base64DataUri }),
    });
    if (!r.ok) throw new Error('fal storage upload failed: ' + r.status);
    const data = await r.json();
    const fileUrl = data.url || data.file_url;
    if (fileUrl) {
      console.log('[RefImage] Uploaded via proxy:', fileUrl.substring(0, 80));
      return fileUrl;
    }
  } catch (e) {
    console.warn('[RefImage] Proxy upload also failed:', e.message);
  }
  return null;
}

// Plan B: Upload base64 to Worker proxy to get a public URL
// Called only if direct base64 submission fails
async function uploadRefImageToProxy(base64DataUri) {
  try {
    console.log('[RefImage] Uploading to proxy for public URL...');
    const r = await fetch(AI_PROXY + '/upload-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64DataUri }),
    });
    if (!r.ok) throw new Error('Upload failed: ' + r.status);
    const data = await r.json();
    if (data.url) {
      console.log('[RefImage] Got public URL from proxy:', data.url.substring(0, 80));
      return data.url;
    }
    throw new Error('No URL in upload response');
  } catch (e) {
    console.error('[RefImage] Proxy upload failed:', e.message);
    return null;
  }
}

// ═══════════════════════════════════════════
// Generic Higgsfield Text-to-Image
// ═══════════════════════════════════════════
async function higgsT2I(endpoint, modelId, prompt, opts = {}) {
  const key = keys.higgs();
  if (!key) throw new Error('Higgsfield API 키가 없습니다.');

  const body = { prompt, aspect_ratio: opts.aspectRatio || '9:16' };

  if (opts.referenceImage) {
    let refUrl = await resolveRefImage(opts.referenceImage);
    // If still base64, try uploading to proxy for public URL
    if (refUrl && refUrl.startsWith('data:')) {
      console.log('[Generator] Base64 detected, uploading to proxy...');
      const publicUrl = await uploadRefImageToProxy(refUrl);
      if (publicUrl) refUrl = publicUrl;
    }
    if (refUrl) {
      body.input_images = [{ image_url: refUrl, type: 'image_url' }];
      const refMode = opts.referenceMode || 'scene';
      if (refMode === 'kontext_edit') {
        // Kontext EDITING mode: image is the BASE to modify, prompt describes ONLY the changes
        body.prompt = 'Edit this image: ' + prompt;
        console.log('[Generator] Kontext EDIT mode — base image attached, prompt describes changes only');
      } else if (refMode === 'object') {
        body.prompt = 'Use the provided reference image as the EXACT object. Keep its appearance, shape, color, and details IDENTICAL to the reference image. Place it naturally in the scene described below. ' + prompt;
      } else {
        body.prompt = 'Use the provided reference image as a style, composition, and mood reference. Match the overall visual feel, color palette, and atmosphere of the reference. Generate the scene described below with this visual direction. ' + prompt;
      }
      console.log('[Generator] Reference image attached for', modelId, '— mode:', refMode);
    }
  }

  let r = await fetch(AI_PROXY + '/higgs/' + endpoint, {
    method: 'POST',
    headers: { 'x-higgs-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // Plan B: If base64 was rejected, try uploading to get a public URL
  if (!r.ok && opts.referenceImage && opts.referenceImage.startsWith('data:')) {
    const errText = await r.text().catch(() => '');
    if (errText.includes('url') || errText.includes('image') || errText.includes('invalid') || r.status === 422 || r.status === 400) {
      console.warn('[Generator] Base64 rejected by API, trying proxy upload (Plan B)...');
      const publicUrl = await uploadRefImageToProxy(opts.referenceImage);
      if (publicUrl) {
        body.input_images = [{ image_url: publicUrl, type: 'image_url' }];
        r = await fetch(AI_PROXY + '/higgs/' + endpoint, {
          method: 'POST',
          headers: { 'x-higgs-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
    }
  }

  if (!r.ok) throw new Error(await parseError(r, modelId));
  const gen = await r.json();
  const direct = extractUrl(gen);
  if (direct) return { url: direct, type: 'image', model: modelId };
  return { ...(await pollHiggs(gen, key)), model: modelId };
}

// ═══════════════════════════════════════════
// Generic Higgsfield Text-to-Video
// ═══════════════════════════════════════════
async function higgsT2V(endpoint, modelId, prompt, opts = {}) {
  const key = keys.higgs();
  if (!key) throw new Error('Higgsfield API 키가 없습니다.');

  // 모델별 최대 해상도 제한
  const modelMaxRes = {
    'veo3.1': '1080',       // Veo 3.1: 720 또는 1080만 지원
    'veo3.1-fast': '1080',
    'kling': '4k',
  };
  const resolution = modelMaxRes[modelId] || '1080';

  const body = {
    prompt,
    aspect_ratio: opts.aspectRatio || '9:16',
    resolution,
    duration: '8',
  };

  if (opts.referenceImage) {
    let refUrl;
    // T2V: always upload base64 to get public URL first (APIs reject long base64)
    if (opts.referenceImage.startsWith('data:')) {
      console.log('[Generator] T2V — uploading reference image for public URL...');
      const publicUrl = await uploadRefImageToProxy(opts.referenceImage);
      refUrl = publicUrl || await resolveRefImage(opts.referenceImage);
    } else {
      refUrl = await resolveRefImage(opts.referenceImage);
    }
    if (refUrl) {
      body.input_images = [{ image_url: refUrl, type: 'image_url' }];
      body.prompt = 'The object from the reference image must appear in the video exactly as shown. ' + prompt;
      console.log('[Generator] Reference image attached for', modelId, '— type:', refUrl.startsWith('data:') ? 'base64' : 'URL');
    }
  }

  let r = await fetch(AI_PROXY + '/higgs/' + endpoint, {
    method: 'POST',
    headers: { 'x-higgs-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!r.ok) throw new Error(await parseError(r, modelId));
  const gen = await r.json();
  const direct = extractUrl(gen);
  if (direct) return { url: direct, type: 'video', model: modelId };
  return { ...(await pollHiggs(gen, key)), type: 'video', model: modelId };
}

// ═══════════════════════════════════════════
// Generic Higgsfield Image-to-Video
// ═══════════════════════════════════════════
async function higgsI2V(endpoint, modelId, prompt, opts = {}) {
  const key = keys.higgs();
  if (!key) throw new Error('Higgsfield API 키가 없습니다.');
  if (!opts.referenceImage) throw new Error(modelId + ': 입력 이미지가 필요합니다 (Image-to-Video 모델)');

  // I2V models REQUIRE a publicly accessible URL — base64 is always too long
  let refUrl;
  if (opts.referenceImage.startsWith('data:')) {
    console.log('[Generator] I2V model — uploading image to proxy for public URL...');
    const publicUrl = await uploadRefImageToProxy(opts.referenceImage);
    if (publicUrl) {
      refUrl = publicUrl;
      console.log('[Generator] I2V image uploaded:', refUrl);
    } else {
      throw new Error(modelId + ': 이미지 업로드 실패 — I2V 모델은 public URL이 필요합니다. 프록시 서버를 확인하세요.');
    }
  } else {
    refUrl = await resolveRefImage(opts.referenceImage);
  }

  // I2V model-specific max resolution
  const i2vMaxRes = {
    'kling': '1080',     // Kling 3.0: up to 4K but API via Higgsfield likely caps at 1080
    'sora2': '1080',     // Sora 2: max 1080p
  };

  const body = {
    prompt,
    input_image: { image_url: refUrl, type: 'image_url' },
    resolution: i2vMaxRes[modelId] || '1080',
    aspect_ratio: opts.aspectRatio || '9:16',
  };

  const r = await fetch(AI_PROXY + '/higgs/' + endpoint, {
    method: 'POST',
    headers: { 'x-higgs-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!r.ok) throw new Error(await parseError(r, modelId));
  const gen = await r.json();
  const direct = extractUrl(gen);
  if (direct) return { url: direct, type: 'video', model: modelId };
  return { ...(await pollHiggs(gen, key)), type: 'video', model: modelId };
}

// ═══════════════════════════════════════════
// Seedance (special: prompts[] array)
// ═══════════════════════════════════════════
async function higgsSeedance(prompt, opts = {}) {
  const key = keys.higgs();
  if (!key) throw new Error('Higgsfield API 키가 없습니다.');
  if (!opts.referenceImage) throw new Error('Seedance: 입력 이미지가 필요합니다 (Image-to-Video 모델)');

  let refUrl = await resolveRefImage(opts.referenceImage);

  const body = {
    prompts: [prompt],
    input_image: { image_url: refUrl, type: 'image_url' },
  };

  let r = await fetch(AI_PROXY + '/higgs/seedance', {
    method: 'POST',
    headers: { 'x-higgs-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // Plan B: proxy upload fallback for Seedance
  if (!r.ok && opts.referenceImage && opts.referenceImage.startsWith('data:')) {
    const errText = await r.text().catch(() => '');
    if (errText.includes('url') || errText.includes('image') || errText.includes('invalid') || r.status === 422 || r.status === 400) {
      console.warn('[Generator] Base64 rejected by API (Seedance), trying proxy upload...');
      const publicUrl = await uploadRefImageToProxy(opts.referenceImage);
      if (publicUrl) {
        body.input_image.image_url = publicUrl;
        r = await fetch(AI_PROXY + '/higgs/seedance', {
          method: 'POST',
          headers: { 'x-higgs-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
    }
  }

  if (!r.ok) throw new Error(await parseError(r, 'Seedance'));
  const gen = await r.json();
  const direct = extractUrl(gen);
  if (direct) return { url: direct, type: 'video', model: 'seedance' };
  return { ...(await pollHiggs(gen, key)), type: 'video', model: 'seedance' };
}

// ═══════════════════════════════════════════
// Soul (special: needs style_id + seed)
// ═══════════════════════════════════════════
async function higgsSoul(prompt, opts = {}) {
  const key = keys.higgs();
  if (!key) throw new Error('Higgsfield API 키가 없습니다.');

  const body = {
    prompt,
    style_id: opts.styleId || 'realistic',
    seed: opts.seed || Math.floor(Math.random() * 999999),
    aspect_ratio: opts.aspectRatio || '9:16',
  };

  const r = await fetch(AI_PROXY + '/higgs/soul', {
    method: 'POST',
    headers: { 'x-higgs-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!r.ok) throw new Error(await parseError(r, 'Soul'));
  const gen = await r.json();
  const direct = extractUrl(gen);
  if (direct) return { url: direct, type: 'image', model: 'soul' };
  return { ...(await pollHiggs(gen, key)), model: 'soul' };
}

// ═══════════════════════════════════════════
// Gemini Direct — NBP with Reference Images
// ═══════════════════════════════════════════
async function generateNBPDirect(prompt, opts = {}) {
  const geminiKey = keys.gemini();
  if (!geminiKey) throw new Error('Gemini API 키가 없습니다 (NBP Direct)');

  // Map ODD Pipe aspect ratios to Gemini imageConfig format
  const geminiAspect = { '9:16': '9:16', '1:1': '1:1', '16:9': '16:9', '4:5': '4:5' };

  // Build contents with text + optional reference images
  const parts = [{ text: prompt }];

  // Add reference images as inline_data (supports multiple with per-image modes)
  const refImages = opts.referenceImages || (opts.referenceImage ? [{ dataUrl: opts.referenceImage, mode: opts.referenceMode || 'scene' }] : []);

  if (refImages.length > 0) {
    const modeInstructions = {
      scene: 'SCENE reference (HIGHEST PRIORITY) — You MUST keep the EXACT same composition, camera angle, spatial layout, subject positioning, and overall scene structure as this image. The reference image defines the visual framework. Only change what the prompt specifically requests to change. Everything else stays identical to the reference.',
      object: 'OBJECT reference — Use this EXACT object in the generated image. Preserve its shape, colors, proportions, textures, and all visual details IDENTICALLY. Place it naturally in the scene described by the prompt.',
      style: 'STYLE reference — Match this image\'s color grading, tone, lighting quality, contrast, saturation level, and overall visual atmosphere. Apply this look to the new scene described in the prompt.'
    };

    // Build reference instruction
    let refInstruction = '';
    refImages.forEach((img, i) => {
      const match = img.dataUrl?.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
      if (match) {
        parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
        refInstruction += `Image ${i+1}: ${modeInstructions[img.mode] || modeInstructions.scene}. `;
      }
    });

    if (refInstruction) {
      // For scene mode, emphasize reference dominance
      const hasScene = refImages.some(r => r.mode === 'scene');
      const sceneWarning = hasScene ? '\nCRITICAL: The SCENE reference image defines the visual structure. Do NOT deviate from its composition, framing, or spatial arrangement. The text prompt below provides ADDITIONAL details only — it does NOT override the reference image layout.\n' : '';
      parts[0].text = `[REFERENCE IMAGES — FOLLOW THESE STRICTLY]\n${refInstruction}${sceneWarning}\n[GENERATION PROMPT]\n${prompt}`;
      console.log('[NBP Direct] Multi-ref:', refImages.map((r,i) => `img${i+1}=${r.mode}`).join(', '));
    }
  }

  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      temperature: 0.8,
      imageConfig: {
        aspectRatio: geminiAspect[opts.aspectRatio] || '9:16',
        imageSize: '4K'
      }
    }
  };

  console.log('[NBP Direct] Calling Gemini API with', parts.length, 'parts, aspect:', opts.aspectRatio || '9:16');

  const r = await fetch(AI_PROXY + '/gemini/gemini-3-pro-image-preview', {
    method: 'POST',
    headers: { 'x-gemini-key': geminiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!r.ok) throw new Error(await parseError(r, 'NBP Direct'));
  const data = await r.json();

  // Check for API-level error
  if (data.error) throw new Error('NBP Direct: ' + (data.error.message || JSON.stringify(data.error)));

  // Extract image from Gemini response
  // Gemini returns inlineData (camelCase) in candidates[0].content.parts
  const candidate = data.candidates?.[0];
  if (!candidate) throw new Error('NBP Direct: 응답에 candidate가 없습니다');

  // Search all parts for image data (order is not guaranteed)
  for (const part of (candidate.content?.parts || [])) {
    // Gemini response uses camelCase: inlineData, mimeType
    const imgData = part.inlineData || part.inline_data;
    if (imgData) {
      const mimeType = imgData.mimeType || imgData.mime_type || 'image/png';
      const b64 = imgData.data;
      const url = `data:${mimeType};base64,${b64}`;
      console.log('[NBP Direct] Got image, mime:', mimeType, 'base64 length:', b64.length);
      return { url, type: 'image', model: 'nano-banana-pro' };
    }

    // Also check for fileData / file_data (alternate response format)
    const fd = part.fileData || part.file_data;
    if (fd) {
      const fileUrl = fd.fileUri || fd.file_uri;
      if (fileUrl) return { url: fileUrl, type: 'image', model: 'nano-banana-pro' };
    }
  }

  throw new Error('NBP Direct: 이미지를 찾지 못했습니다');
}

// ═══════════════════════════════════════════
// IMAGE — Premium Higgsfield Models
// ═══════════════════════════════════════════
export const generateNanoBanana = (p, o) => {
  console.log('[Generator] NBP → Gemini Direct API', o?.referenceImage ? '(with reference)' : '(no reference)');
  return generateNBPDirect(p, o);
};
export const generateFluxMax = (p, o) => higgsT2I('flux-2-max', 'flux-max', p, o);
export const generateFluxKontext = (p, o = {}) => {
  // Kontext is an IMAGE EDITING model — reference image is the BASE to edit
  if (o?.referenceImage) {
    // Use fal.ai direct API for REAL image editing (not Higgsfield reference mode)
    return falKontextEdit(p, o.referenceImage, o);
  }
  // No reference image — use Higgsfield for text-to-image generation
  return higgsT2I('flux-kontext', 'flux-kontext', p, o);
};
export const generateReve = (p, o) => higgsT2I('reve', 'reve', p, o);

// ═══════════════════════════════════════════
// fal.ai Direct Models
// ═══════════════════════════════════════════
async function falT2I(endpoint, modelId, prompt, opts = {}) {
  const key = keys.fal();
  if (!key) throw new Error('fal.ai API 키가 없습니다.');
  const size = falImageSize(opts.aspectRatio || '9:16');
  const body = { prompt, image_size: size };

  // Reference image support
  if (opts.referenceImage) {
    let imageUrl = opts.referenceImage;
    if (imageUrl.startsWith('data:')) {
      const publicUrl = await uploadRefImageToProxy(imageUrl);
      if (publicUrl) imageUrl = publicUrl;
    }
    body.image_url = imageUrl;
  }

  console.log('[Generator] fal.ai direct:', modelId, '→', endpoint);
  const r = await fetch(AI_PROXY + '/fal/' + endpoint, {
    method: 'POST',
    headers: { 'x-fal-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await parseError(r, modelId));
  const gen = await r.json();
  if (gen.images?.[0]?.url) return { url: gen.images[0].url, type: 'image', model: modelId };
  if (gen.request_id) return { ...(await pollFal(gen.request_id, key, endpoint, gen)), model: modelId };
  const url = extractUrl(gen);
  if (url) return { url, type: 'image', model: modelId };
  throw new Error('fal.ai: 결과 URL 없음');
}

export const generateFlux2Pro = (p, o) => falT2I('fal-ai/flux-2-pro', 'flux-2-pro', p, o);
export const generateSeedream = (p, o) => falT2I('fal-ai/bytedance/seedream/v4.5/text-to-image', 'seedream', p, o);

// ── Utility: Upscale (AuraSR 4x) ──
export async function upscaleImage(imageUrl) {
  const key = keys.fal();
  if (!key) throw new Error('fal.ai API 키가 없습니다.');
  let imgUrl = imageUrl;
  if (imageUrl.startsWith('data:')) {
    const publicUrl = await uploadRefImageToProxy(imageUrl);
    if (publicUrl) imgUrl = publicUrl;
  }
  const r = await fetch(AI_PROXY + '/fal/fal-ai/aura-sr', {
    method: 'POST',
    headers: { 'x-fal-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: imgUrl }),
  });
  if (!r.ok) throw new Error(await parseError(r, 'aura-sr'));
  const gen = await r.json();
  if (gen.image?.url) return { url: gen.image.url, type: 'image', model: 'aura-sr' };
  if (gen.request_id) return { ...(await pollFal(gen.request_id, key, 'fal-ai/aura-sr', gen)), model: 'aura-sr' };
  throw new Error('AuraSR: 결과 URL 없음');
}

// ── Utility: Background Removal (BiRefNet v2) ──
export async function removeBackground(imageUrl) {
  const key = keys.fal();
  if (!key) throw new Error('fal.ai API 키가 없습니다.');
  let imgUrl = imageUrl;
  if (imageUrl.startsWith('data:')) {
    const publicUrl = await uploadRefImageToProxy(imageUrl);
    if (publicUrl) imgUrl = publicUrl;
  }
  const r = await fetch(AI_PROXY + '/fal/fal-ai/birefnet/v2', {
    method: 'POST',
    headers: { 'x-fal-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: imgUrl }),
  });
  if (!r.ok) throw new Error(await parseError(r, 'birefnet'));
  const gen = await r.json();
  if (gen.image?.url) return { url: gen.image.url, type: 'image', model: 'birefnet' };
  if (gen.request_id) return { ...(await pollFal(gen.request_id, key, 'fal-ai/birefnet/v2', gen)), model: 'birefnet' };
  throw new Error('BiRefNet: 결과 URL 없음');
}

// ═══════════════════════════════════════════
// VIDEO — fal.ai Direct
// ═══════════════════════════════════════════
async function falT2V(endpoint, modelId, prompt, opts = {}) {
  const key = keys.fal();
  if (!key) throw new Error('fal.ai API 키가 없습니다.');

  // Model-specific defaults
  const isVeo = endpoint.includes('veo');
  const isSeedance = endpoint.includes('seedance');
  const isKling = endpoint.includes('kling');
  const hasRefImage = !!opts.referenceImage;

  // ── Duration: use slider value (opts.duration) or model default ──
  // Veo: "4s"/"6s"/"8s" (needs 's' suffix)
  // Seedance: "4"-"15" (plain number string)
  // Kling: "5"/"10" (plain number string)
  let duration;
  if (isVeo) {
    const raw = opts.duration || '8';
    const num = parseInt(raw);
    // Veo only allows 4s/6s/8s — snap to nearest valid
    const valid = [4, 6, 8];
    const snapped = valid.reduce((a, b) => Math.abs(b - num) < Math.abs(a - num) ? b : a);
    duration = snapped + 's';
  } else if (isSeedance) {
    const raw = opts.duration || '10';
    const num = Math.max(4, Math.min(15, parseInt(raw)));
    duration = String(num);
  } else if (isKling) {
    const raw = opts.duration || '10';
    const num = parseInt(raw);
    duration = num <= 7 ? '5' : '10'; // Kling only allows 5 or 10
  } else {
    duration = opts.duration || '5';
  }

  // ── Aspect ratio: validate per model ──
  let aspectRatio = opts.aspectRatio || '9:16';
  if (isVeo) {
    // Veo only supports 16:9, 9:16 (T2V) or auto, 16:9, 9:16 (I2V)
    if (!['16:9', '9:16'].includes(aspectRatio)) {
      aspectRatio = hasRefImage ? 'auto' : '16:9';
      console.log('[Generator] Veo: unsupported AR, falling back to', aspectRatio);
    }
  }

  const body = {
    prompt,
    aspect_ratio: aspectRatio,
    duration,
  };

  // ── Resolution per model ──
  if (isVeo) {
    body.resolution = '1080p'; // Veo: supports 720p/1080p/4k — use 1080p
    body.safety_tolerance = 6; // Most permissive (1-6) — avoid unnecessary 422 from content filter
    body.generate_audio = true;  // Enable native audio generation
  }
  if (isSeedance) {
    body.resolution = '720p'; // Seedance: max 720p for both T2V and I2V
  }

  // ── Non-Kling: strip any KLING_CAMERA tag that leaked from I2V prompt template ──
  if (!isKling) {
    body.prompt = prompt.replace(/\s*\[KLING_CAMERA:[^\]]+\]/gi, '').trim();
  }

  // ── Kling: parse [KLING_CAMERA: ...] tag from prompt + set cfg_scale ──
  if (isKling) {
    body.cfg_scale = 0.7; // 0.5 default is too loose — 0.7 improves prompt adherence

    // Parse and strip the camera control tag emitted by the prompt optimizer
    const klingTagMatch = prompt.match(/\[KLING_CAMERA:\s*([^\]]+)\]/i);
    if (klingTagMatch) {
      const tagContent = klingTagMatch[1].trim();
      // Remove the tag from the prompt text
      body.prompt = prompt.replace(/\s*\[KLING_CAMERA:[^\]]+\]/gi, '').trim();

      if (tagContent !== 'none') {
        // Predefined movement types
        if (tagContent === 'orbit_right') {
          body.camera_control = { type: 'right_turn_forward' };
        } else if (tagContent === 'orbit_left') {
          body.camera_control = { type: 'left_turn_forward' };
        } else {
          // Numeric config: zoom=6, horizontal=-5, vertical=4, etc.
          const config = {};
          const kvMatches = tagContent.matchAll(/(\w+)=(-?\d+(?:\.\d+)?)/g);
          for (const [, k, v] of kvMatches) {
            config[k] = parseFloat(v);
          }
          if (Object.keys(config).length > 0) {
            body.camera_control = { type: 'simple', config };
          }
        }
        if (body.camera_control) {
          console.log('[Generator] Kling camera_control:', JSON.stringify(body.camera_control));
        }
      }
    } else {
      // No tag found — still strip prompt, use as-is, no camera_control
      body.prompt = prompt;
    }
  }

  // Add reference image if provided + mode-specific prompt prefix
  if (opts.referenceImage) {
    // Base64 data URIs: upload to fal.ai storage first to get a proper URL
    // Some models (Seedance, Kling) silently ignore raw base64 and return demo videos
    let imageUrl = opts.referenceImage;
    if (imageUrl.startsWith('data:')) {
      console.log('[Generator] Uploading base64 to fal.ai storage for', modelId, '...');
      const falUrl = await uploadToFalStorage(imageUrl);
      if (falUrl) {
        imageUrl = falUrl;
        console.log('[Generator] Got fal.ai storage URL:', falUrl.substring(0, 80));
      } else {
        console.warn('[Generator] fal.ai storage upload failed, trying base64 direct');
      }
    }
    body.image_url = imageUrl;
    console.log('[Generator] fal.ai T2V — image attached', imageUrl.startsWith('data:') ? '(base64 fallback)' : '(URL)');

    // Build final prompt — Veo I2V vs other models need different treatment
    const mode = opts.referenceMode || 'scene';

    if (isVeo) {
      // Veo I2V: extract negative_prompt from text → send as separate body param
      let veoPrompt = body.prompt || prompt;
      const npMatch = veoPrompt.match(/\n?negative_prompt:\s*(.+)$/im);
      if (npMatch) {
        body.negative_prompt = npMatch[1].trim();
        veoPrompt = veoPrompt.replace(/\n?negative_prompt:.*$/im, '').trim();
      }
      body.prompt = veoPrompt;
      console.log('[Generator] Veo I2V — prompt:', veoPrompt.length, 'chars', npMatch ? '+ negative_prompt param' : '(no negative_prompt)');
    } else {
      // Non-Veo (Kling, Seedance): modePrefix already handled above for Kling, apply for others
      if (!isKling) {
        const modePrefix = {
          scene: 'Animate the scene starting from this reference image with subtle natural motion. ',
          object: 'The object shown in the reference image must appear in the video exactly as shown — same shape, color, proportions, and details. ',
          style: 'Match the color grading, lighting quality, tone, and visual atmosphere of the reference image. '
        };
        body.prompt = (modePrefix[mode] || '') + (body.prompt || prompt);
      }
    }
    console.log('[Generator] fal.ai T2V reference attached for', modelId, '— mode:', mode);
  }

  console.log('[Generator] fal.ai T2V:', modelId, '→', endpoint);
  const r = await fetch(AI_PROXY + '/fal/' + endpoint, {
    method: 'POST',
    headers: { 'x-fal-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await parseError(r, modelId));
  const gen = await r.json();
  // Check for direct result
  const url = gen.video?.url || extractUrl(gen);
  if (url) return { url, type: 'video', model: modelId };
  // Queue — poll for result
  if (gen.request_id) {
    return { ...(await pollFal(gen.request_id, key, endpoint, gen)), type: 'video', model: modelId };
  }
  throw new Error(modelId + ': 생성 시작 실패');
}

export const generateVeo31 = (p, o) => {
  // Veo 3.1 Quality — T2V or I2V depending on reference image
  const endpoint = o?.referenceImage
    ? 'fal-ai/veo3.1/image-to-video'
    : 'fal-ai/veo3.1';
  return falT2V(endpoint, 'veo3.1', p, o);
};

export const generateVeo31Fast = (p, o) => {
  // Veo 3.1 Fast — same params, faster inference (~1-3min vs 5-10min)
  const endpoint = o?.referenceImage
    ? 'fal-ai/veo3.1/fast/image-to-video'
    : 'fal-ai/veo3.1/fast';
  return falT2V(endpoint, 'veo3.1-fast', p, o);
};
export const generateSeedance2 = (p, o) => {
  // Seedance 2.0: use I2V if reference image, T2V otherwise
  const endpoint = o?.referenceImage
    ? 'fal-ai/bytedance/seedance/v2/image-to-video'
    : 'fal-ai/bytedance/seedance/v2/text-to-video';
  return falT2V(endpoint, 'seedance2', p, o);
};

// VIDEO — fal.ai First/Last Frame to Video
// ─────────────────────────────────────────
async function falFLF(endpoint, modelId, prompt, opts = {}) {
  const key = keys.fal();
  if (!key) throw new Error('fal.ai API 키가 없습니다.');
  if (!opts.firstFrameUrl) throw new Error(modelId + ': 첫 번째 프레임 이미지가 필요합니다');
  if (!opts.lastFrameUrl)  throw new Error(modelId + ': 마지막 프레임 이미지가 필요합니다');

  // Upload base64 images to fal storage
  const upload = async (url, label) => {
    if (!url.startsWith('data:')) return url;
    console.log('[Generator] FLF uploading', label, 'to fal.ai storage...');
    const uploaded = await uploadToFalStorage(url);
    if (!uploaded) throw new Error(label + ' 업로드 실패');
    return uploaded;
  };

  const [firstUrl, lastUrl] = await Promise.all([
    upload(opts.firstFrameUrl, '첫 번째 프레임'),
    upload(opts.lastFrameUrl, '마지막 프레임'),
  ]);

  // Duration: snap to 4s/6s/8s
  const raw = opts.duration || '8';
  const num = parseInt(raw);
  const duration = [4, 6, 8].reduce((a, b) => Math.abs(b - num) < Math.abs(a - num) ? b : a) + 's';

  const body = {
    prompt,
    first_frame_url: firstUrl,
    last_frame_url: lastUrl,
    aspect_ratio: ['auto', '16:9', '9:16'].includes(opts.aspectRatio) ? opts.aspectRatio : 'auto',
    duration,
    resolution: '1080p',
    generate_audio: true,
    safety_tolerance: 6,
  };

  console.log('[Generator] fal.ai FLF:', modelId, '→', endpoint, '| dur:', duration);
  const r = await fetch(AI_PROXY + '/fal/' + endpoint, {
    method: 'POST',
    headers: { 'x-fal-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await parseError(r, modelId));
  const gen = await r.json();
  const url = gen.video?.url || extractUrl(gen);
  if (url) return { url, type: 'video', model: modelId };
  if (gen.request_id) {
    return { ...(await pollFal(gen.request_id, key, endpoint, gen)), type: 'video', model: modelId };
  }
  throw new Error(modelId + ': 생성 시작 실패');
}

export const generateVeo31FLF = (p, o) =>
  falFLF('fal-ai/veo3.1/first-last-frame-to-video', 'veo3.1-flf', p, o);
export const generateVeo31FastFLF = (p, o) =>
  falFLF('fal-ai/veo3.1/fast/first-last-frame-to-video', 'veo3.1-fast-flf', p, o);

// VIDEO — fal.ai Reference to Video
// ─────────────────────────────────────────
async function falRef2V(endpoint, modelId, prompt, opts = {}) {
  const key = keys.fal();
  if (!key) throw new Error('fal.ai API 키가 없습니다.');

  const refImages = opts.referenceImages || (opts.referenceImage ? [{ dataUrl: opts.referenceImage }] : []);
  if (refImages.length === 0) throw new Error(modelId + ': 레퍼런스 이미지가 최소 1개 필요합니다');

  // Upload all reference images (max 2) to fal storage
  const imageUrls = await Promise.all(
    refImages.slice(0, 2).map(async (img, i) => {
      const url = img.dataUrl || img;
      if (!url.startsWith('data:')) return url;
      console.log('[Generator] Ref2V uploading ref', i + 1, 'to fal.ai storage...');
      const uploaded = await uploadToFalStorage(url);
      if (!uploaded) throw new Error('레퍼런스 이미지 ' + (i + 1) + ' 업로드 실패');
      return uploaded;
    })
  );

  // Duration: snap to 4s/6s/8s
  const raw = opts.duration || '8';
  const num = parseInt(raw);
  const duration = [4, 6, 8].reduce((a, b) => Math.abs(b - num) < Math.abs(a - num) ? b : a) + 's';

  // AR: only 16:9 or 9:16 (no "auto" for ref2v)
  const ar = ['16:9', '9:16'].includes(opts.aspectRatio) ? opts.aspectRatio : '9:16';

  const body = {
    prompt,
    image_urls: imageUrls,
    aspect_ratio: ar,
    duration,
    resolution: '1080p',
    generate_audio: true,
    safety_tolerance: 6,
  };

  console.log('[Generator] fal.ai Ref2V:', modelId, '→', endpoint, '| refs:', imageUrls.length, '| dur:', duration);
  const r = await fetch(AI_PROXY + '/fal/' + endpoint, {
    method: 'POST',
    headers: { 'x-fal-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await parseError(r, modelId));
  const gen = await r.json();
  const url = gen.video?.url || extractUrl(gen);
  if (url) return { url, type: 'video', model: modelId };
  if (gen.request_id) {
    return { ...(await pollFal(gen.request_id, key, endpoint, gen)), type: 'video', model: modelId };
  }
  throw new Error(modelId + ': 생성 시작 실패');
}

export const generateVeo31Ref = (p, o) =>
  falRef2V('fal-ai/veo3.1/reference-to-video', 'veo3.1-ref', p, o);

// VIDEO — fal.ai (Kling) + Higgsfield (Sora2)
export const generateKling = (p, o) => {
  if (!o?.referenceImage) throw new Error('Kling 2.0: 입력 이미지가 필요합니다 (Image-to-Video 모델)');
  return falT2V('fal-ai/kling-video/v2/master/image-to-video', 'kling', p, o);
};
export const generateSora2 = (p, o) => higgsI2V('sora2', 'sora2', p, o);

// ═══════════════════════════════════════════
// Unified Entry Point
// ═══════════════════════════════════════════
const MODEL_MAP = {
  // Image — Gemini Direct
  'nano-banana-pro': generateNanoBanana,
  // Image — Higgsfield
  'flux-max': generateFluxMax,
  'flux-kontext': generateFluxKontext,
  'reve': generateReve,
  // Image — fal.ai direct
  'flux-2-pro': generateFlux2Pro,
  'seedream': generateSeedream,
  // Video — fal.ai direct
  'veo3.1': generateVeo31,
  'veo3.1-fast': generateVeo31Fast,
  'veo3.1-flf': generateVeo31FLF,
  'veo3.1-fast-flf': generateVeo31FastFLF,
  'veo3.1-ref': generateVeo31Ref,
  'seedance2': generateSeedance2,
  // Video — Higgsfield
  'kling': generateKling,
  'sora2': generateSora2,
};

export async function generateAsset(model, prompt, opts = {}) {
  const fn = MODEL_MAP[model];
  if (!fn) throw new Error('Unknown model: ' + model);
  return fn(prompt, opts);
}

export function getAvailableModels() {
  const h = !!keys.higgs();
  const f = !!keys.fal();
  return {
    'nano-banana-pro': true, 'flux-max': h, 'flux-kontext': h || f, 'reve': h,
    'flux-2-pro': f, 'seedream': f,
    'veo3.1': f, 'veo3.1-fast': f, 'veo3.1-flf': f, 'veo3.1-fast-flf': f, 'veo3.1-ref': f,
    'seedance2': f, 'kling': f, 'sora2': h,
  };
}

// ═══════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════

function extractUrl(gen) {
  // Debug: log full response structure to diagnose missing URLs
  console.log('[extractUrl] Response keys:', Object.keys(gen), JSON.stringify(gen).substring(0, 500));

  // Direct URL fields
  if (gen.output?.url) return gen.output.url;
  if (gen.output?.image_url) return gen.output.image_url;
  if (gen.output?.video_url) return gen.output.video_url;
  if (gen.output?.video) return typeof gen.output.video === 'string' ? gen.output.video : gen.output.video?.url;
  if (gen.image_url) return gen.image_url;
  if (gen.video_url) return gen.video_url;
  if (gen.video) return typeof gen.video === 'string' ? gen.video : gen.video.url;
  if (gen.videos?.[0]) return typeof gen.videos[0] === 'string' ? gen.videos[0] : gen.videos[0].url;
  if (gen.images?.[0]) return typeof gen.images[0] === 'string' ? gen.images[0] : gen.images[0].url;
  if (gen.result?.url) return gen.result.url;
  if (gen.result?.video_url) return gen.result.video_url;
  if (gen.result?.image_url) return gen.result.image_url;
  if (gen.artifacts?.[0]?.url) return gen.artifacts[0].url;
  if (gen.data?.[0]?.url) return gen.data[0].url;
  if (gen.data?.url) return gen.data.url;
  if (gen.data?.video_url) return gen.data.video_url;
  if (typeof gen.output === 'string' && gen.output.startsWith('http')) return gen.output;
  if (typeof gen.result === 'string' && gen.result.startsWith('http')) return gen.result;

  // Regex fallback: find any media URL in the JSON
  const jsonStr = JSON.stringify(gen);
  const urlMatch = jsonStr.match(/https?:\/\/[^"'\s\\]+\.(mp4|webm|mov|jpg|jpeg|png|webp|gif)/i);
  if (urlMatch) {
    console.warn('[extractUrl] URL found via regex fallback:', urlMatch[0]);
    return urlMatch[0];
  }

  return null;
}

async function pollHiggs(gen, key) {
  const pollId = gen.request_id || gen.id || gen.generation_id;
  if (!pollId) throw new Error('생성 ID를 받지 못했습니다');

  const statusUrl = gen.status_url;
  const pollPath = statusUrl
    ? statusUrl.replace('https://platform.higgsfield.ai', '')
    : '/requests/' + pollId + '/status';

  for (let i = 0; i < 120; i++) {
    await sleep(3000);
    const sr = await fetch(AI_PROXY + '/higgs' + pollPath, { headers: { 'x-higgs-key': key } });
    if (!sr.ok) continue;
    const st = await sr.json();
    const state = st.status || st.state;

    if (state === 'completed' || state === 'succeeded') {
      const url = extractUrl(st);
      if (url) {
        // Determine type from URL extension
        const isVideo = /\.(mp4|webm|mov)(\?|$)/i.test(url);
        return { url, type: isVideo ? 'video' : 'image' };
      }
      // extractUrl already does regex fallback, but try one more time on stringified response
      const jsonStr = JSON.stringify(st);
      const urlMatch = jsonStr.match(/https?:\/\/[^"'\s\\]+\.(mp4|webm|mov|jpg|jpeg|png|webp|gif)/i);
      if (urlMatch) {
        console.warn('[pollHiggs] URL found via secondary regex fallback:', urlMatch[0]);
        const isVideo = /\.(mp4|webm|mov)/i.test(urlMatch[0]);
        return { url: urlMatch[0], type: isVideo ? 'video' : 'image' };
      }
      // Try any URL at all (some APIs return CDN URLs without file extensions)
      const anyUrlMatch = jsonStr.match(/(https?:\/\/[^"'\s\\]{20,})/i);
      if (anyUrlMatch && !anyUrlMatch[0].includes('platform.higgsfield.ai')) {
        console.warn('[pollHiggs] Non-extension URL found as last resort:', anyUrlMatch[0]);
        return { url: anyUrlMatch[0], type: 'image' };
      }
      console.error('[pollHiggs] Completed but no URL found. Full response:', jsonStr.substring(0, 1000));
      throw new Error('완료되었지만 URL을 찾지 못했습니다');
    }
    if (state === 'failed' || state === 'error') throw new Error(st.error || '생성 실패');
  }
  throw new Error('시간 초과 (6분)');
}

async function pollFal(requestId, key, endpoint, genResponse) {
  const hasRealKey = key && key !== 'USE_SERVER_KEY';
  const base = hasRealKey ? 'https://queue.fal.run/' : AI_PROXY + '/fal/';
  const toProxy = (url) => hasRealKey ? url : AI_PROXY + '/fal/' + url.replace('https://queue.fal.run/', '');

  // Build status URL and result URL from response or fallback
  const statusUrl = genResponse?.status_url
    ? toProxy(genResponse.status_url)
    : base + endpoint + '/requests/' + requestId + '/status';
  const resultUrl = genResponse?.response_url
    ? toProxy(genResponse.response_url)
    : base + endpoint + '/requests/' + requestId;

  const pollHeaders = hasRealKey
    ? { 'Authorization': 'Key ' + key }
    : { 'x-fal-key': key };

  console.log('[pollFal] statusUrl:', statusUrl);
  console.log('[pollFal] resultUrl:', resultUrl);

  // Poll up to 15 minutes (300 × 3s) — Veo 3.1 Quality can take 5-12 min
  for (let i = 0; i < 300; i++) {
    await sleep(3000);
    try {
      // Step 1: Check status
      const sr = await fetch(statusUrl, { headers: pollHeaders });
      const stText = await sr.text();
      let st;
      try { st = JSON.parse(stText); } catch(e) {
        console.warn('[pollFal] status JSON parse failed, retrying');
        continue;
      }

      const status = st.status || st.state || '';
      console.log('[pollFal]', status || '?', '(' + (i+1) + '/200)');

      if (status === 'FAILED' || status === 'failed' || status === 'error') {
        const errDetail = st.error || JSON.stringify(st.detail || st.message || '') || '알 수 없는 오류';
        throw new Error('fal.ai: 생성 실패 — ' + errDetail);
      }

      if (status !== 'COMPLETED' && status !== 'completed' && status !== 'succeeded') {
        // IN_QUEUE / IN_PROGRESS — keep waiting
        continue;
      }

      // Step 2: Status is COMPLETED — fetch result
      const rr = await fetch(resultUrl, { headers: pollHeaders });
      if (!rr.ok) {
        if (rr.status === 422) {
          // 422 on result fetch = content filter blocked the output
          const errBody = await rr.text().catch(() => '');
          console.error('[pollFal] COMPLETED but result blocked (422):', errBody.substring(0, 300));
          throw new Error('fal.ai: 생성은 완료됐지만 콘텐츠 필터에 의해 결과가 차단되었습니다. 프롬프트를 수정해 주세요.');
        }
        console.warn('[pollFal] result fetch HTTP', rr.status, '— retrying');
        continue;
      }
      let result;
      try { result = await rr.json(); } catch(e) {
        console.warn('[pollFal] result JSON parse failed, retrying');
        continue;
      }

      // Extract media URL (video takes priority, then image)
      const url = result.video?.url
        || result.videos?.[0]?.url
        || result.images?.[0]?.url
        || result.image?.url
        || result.output?.url
        || extractUrl(result);

      if (url) {
        console.log('[pollFal] ✅ Got URL:', url.substring(0, 80));
        const isVideo = /\.(mp4|webm|mov)(\?|$)/i.test(url);
        return { url, type: isVideo ? 'video' : 'image' };
      }

      console.error('[pollFal] COMPLETED but no URL found. Response:', JSON.stringify(result).substring(0, 500));
      throw new Error('fal.ai: 완료됐지만 URL을 찾지 못했습니다');

    } catch (err) {
      if (err.message.startsWith('fal.ai:')) throw err; // re-throw our own errors
      console.warn('[pollFal] Error:', err.message, '— retrying');
    }
  }
  throw new Error('fal.ai: 시간 초과 (10분)');
}

// ═══════════════════════════════════════════
// fal.ai FLUX Kontext — Direct Image Editing
// ═══════════════════════════════════════════
async function falKontextEdit(prompt, imageDataUrl, opts = {}) {
  const key = keys.fal();
  if (!key) throw new Error('fal.ai API 키가 없습니다.');

  const endpoint = 'fal-ai/flux-pro/kontext/max';

  // fal.ai accepts base64 data URIs directly — no upload needed
  let imageUrl = imageDataUrl;

  // Strip any unwanted prefixes from the prompt optimizer
  let cleanPrompt = prompt
    .replace(/^Use the provided reference image as a style.*?atmosphere\.\s*/i, '')
    .replace(/^Edit this image:\s*/i, '')
    .trim();

  const body = {
    prompt: cleanPrompt,
    image_url: imageUrl,
    output_format: 'png',         // PNG for maximum quality (no JPEG compression)
    guidance_scale: 4.5,          // Slightly higher than default 3.5 for better edit adherence
    safety_tolerance: 6,          // Most permissive — avoid unnecessary content blocking
    num_images: 1,
  };

  console.log('[Generator] fal.ai Kontext Max EDIT mode — clean prompt:', cleanPrompt.substring(0, 80));

  const r = await fetch(AI_PROXY + '/fal/' + endpoint, {
    method: 'POST',
    headers: { 'x-fal-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error('fal.ai Kontext: ' + (errText || r.statusText));
  }

  const gen = await r.json();

  // Direct result
  if (gen.images?.[0]?.url) return { url: gen.images[0].url, type: 'image', model: 'flux-kontext' };

  // Async — poll for result
  if (gen.request_id) {
    return { ...(await pollFal(gen.request_id, key, endpoint, gen)), model: 'flux-kontext' };
  }

  // Fallback: try to extract URL from response
  const url = extractUrl(gen);
  if (url) return { url, type: 'image', model: 'flux-kontext' };

  throw new Error('fal.ai Kontext: 결과 URL 없음');
}

async function parseError(response, provider) {
  const txt = await response.text().catch(() => '');
  try {
    const e = JSON.parse(txt);
    return provider + ': ' + (e.error?.message || e.detail || e.message || e.error || response.status);
  } catch {
    return provider + ' API 오류 (' + response.status + ')' + (txt ? ': ' + txt.substring(0, 100) : '');
  }
}

function sleep(ms) { return new Promise(ok => setTimeout(ok, ms)); }
// deploy-bust: 1774684018
