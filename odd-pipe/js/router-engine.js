// ═══════════════════════════════════════════
// ODD Pipe — Smart Model Router
// 12 Models: 5 Image (Higgsfield) + 4 Video (Higgsfield) + 3 External
// ═══════════════════════════════════════════

const AI_PROXY = 'https://odd-ai-proxy.it-751.workers.dev';

const ROUTER_SYSTEM = `You are a visual asset routing engine for ODD brand. Given a creative brief, respond with ONLY a JSON object (no markdown):

{
  "model": "<model_id>",
  "reason": "<one sentence in Korean>",
  "asset_type": "image" | "video",
  "style": "product" | "lifestyle" | "editorial" | "conceptual" | "typography" | "motion",
  "needs_reference": true | false
}

=== IMAGE MODELS (text-to-image) ===
- nano-banana-pro: Best 4K product shots, structural precision. Use when M-01 bottle must appear accurately.
- flux-2: Fast high-quality images via Higgsfield. Good general purpose, artistic/editorial.
- soul: Ultra-realistic fashion/editorial imagery. Best for lifestyle/fashion visuals.
- reve: Creative/artistic imagery. Good for conceptual, abstract, mood-driven content.
- gpt-image: OpenAI GPT Image. Most versatile, complex multi-element scenes. (requires OpenAI key)
- flux-pro: FLUX.2 Pro via fal.ai. Artistic aesthetics, LoRA support. (requires fal key)
- ideogram: Best for readable text in images, typography, posters. (requires Ideogram key)

=== VIDEO MODELS ===
Text-to-video (no input image needed):
- veo3: Google Veo 3 via Higgsfield. Best text-to-video quality. Cinematic.

Image-to-video (requires input image):
- kling: Kling 3.0. 15sec, character consistency. Best overall i2v quality.
- sora2: Sora 2 (OpenAI). Cinematic quality, smooth motion.
- minimax: MiniMax Hailuo. Fast i2v.
- seedance: Seedance Pro. Multi-prompt, good for product rotation/reveal.

needs_reference = true ONLY when M-01 product bottle must appear with visual accuracy.`;

function ruleBasedRoute(brief) {
  const lower = brief.toLowerCase();

  const videoKw = ['video', 'motion', 'clip', 'reels', 'animation', 'cinematic', '영상', '동영상', '비디오', '릴스', '숏폼', '모션', '클립'];
  if (videoKw.some(k => lower.includes(k))) {
    const hasRef = ['product', 'bottle', 'M-01', 'm-01', '제품', '병'].some(k => lower.includes(k));
    if (hasRef) return { model: 'kling', reason: '제품이 등장하는 영상 — Kling I2V', asset_type: 'video', style: 'motion', needs_reference: true, confidence: 'high' };
    return { model: 'veo3.1', reason: '영상 콘텐츠 — Veo 3 T2V', asset_type: 'video', style: 'motion', needs_reference: false, confidence: 'high' };
  }

  const textKw = ['text on', 'typography', 'logo', 'signage', 'poster', 'banner text', '타이포', '텍스트 포함', '문구 삽입', '포스터', '배너'];
  if (textKw.some(k => lower.includes(k))) return { model: 'ideogram', reason: '텍스트/타이포그래피 포함 이미지', asset_type: 'image', style: 'typography', needs_reference: false, confidence: 'high' };

  const productKw = ['product shot', 'product hero', 'bottle', 'red bottle', 'vial', 'packaging', '제품 사진', '제품 샷', '병', '바이알', '패키지'];
  if (productKw.some(k => lower.includes(k))) return { model: 'nano-banana-pro', reason: 'M-01 제품 비주얼 — NBP 4K', asset_type: 'image', style: 'product', needs_reference: true, confidence: 'high' };

  const cinematicImgKw = ['cinematic photo', 'film still', 'filmic', 'film look', 'movie still', '시네마틱 이미지', '필름 룩', '영화 스틸'];
  if (cinematicImgKw.some(k => lower.includes(k)) && !videoKw.some(k => lower.includes(k))) return { model: 'reve', reason: '시네마틱/필름 이미지 — Reve', asset_type: 'image', style: 'editorial', needs_reference: false, confidence: 'high' };

  const portraitKw = ['portrait', 'headshot', 'beauty shot', 'face', 'skin', '포트레이트', '인물', '뷰티 샷'];
  if (portraitKw.some(k => lower.includes(k))) return { model: 'flux-max', reason: '인물/뷰티 — FLUX Max', asset_type: 'image', style: 'editorial', needs_reference: false, confidence: 'high' };

  const fashionKw = ['fashion', 'editorial', 'lifestyle', 'model', '패션', '에디토리얼', '라이프스타일', '모델'];
  if (fashionKw.some(k => lower.includes(k))) return { model: 'flux-max', reason: '패션/에디토리얼 — FLUX Max', asset_type: 'image', style: 'editorial', needs_reference: false, confidence: 'high' };

  const artKw = ['artistic', 'abstract', 'illustration', 'conceptual', 'mood', 'aesthetic', '아트', '컨셉', '무드', '추상'];
  if (artKw.some(k => lower.includes(k))) return { model: 'reve', reason: '아트/컨셉추얼 — Reve', asset_type: 'image', style: 'conceptual', needs_reference: false, confidence: 'high' };

  const m01Kw = ['m-01', 'm01', 'odd bottle', 'odd 병'];
  if (m01Kw.some(k => lower.includes(k))) return { model: 'nano-banana-pro', reason: 'M-01 제품 비주얼', asset_type: 'image', style: 'product', needs_reference: true, confidence: 'medium' };

  return null;
}

async function geminiRoute(brief) {
  const geminiKey = localStorage.getItem('odd_gemini_key') || '';
  if (!geminiKey) return null;
  try {
    const r = await fetch(AI_PROXY + '/gemini/gemini-2.5-flash', {
      method: 'POST',
      headers: { 'x-gemini-key': geminiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: ROUTER_SYSTEM }] },
        contents: [{ parts: [{ text: 'Creative brief:\n' + brief }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 200, topP: 0.5 },
      }),
    });
    if (!r.ok) {
      if (r.status === 429) {
        console.warn('[Router] Gemini quota exceeded, trying Claude');
        return await claudeRoute(brief);
      }
      return null;
    }
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) return null;
    const result = JSON.parse(text.replace(/```json\s*/, '').replace(/```\s*$/, '').trim());
    if (!result.model || !result.reason) return null;
    return { ...result, confidence: 'gemini' };
  } catch (e) {
    console.warn('[Router] Gemini failed:', e.message, '— trying Claude');
    return await claudeRoute(brief);
  }
}

async function claudeRoute(brief) {
  const claudeKey = localStorage.getItem('odd_ai_key') || '';
  if (!claudeKey) return null;
  try {
    const r = await fetch(AI_PROXY, {
      method: 'POST',
      headers: { 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        system: ROUTER_SYSTEM,
        messages: [{ role: 'user', content: 'Creative brief:\n' + brief }],
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const text = data?.content?.[0]?.text?.trim();
    if (!text) return null;
    const result = JSON.parse(text.replace(/```json\s*/, '').replace(/```\s*$/, '').trim());
    if (!result.model || !result.reason) return null;
    console.log('[Router] ✅ Claude Opus 4.6 fallback succeeded');
    return { ...result, confidence: 'claude' };
  } catch (e) {
    console.warn('[Router] Claude fallback also failed:', e.message);
    return null;
  }
}

export async function routeBrief(brief) {
  const ruleResult = ruleBasedRoute(brief);
  if (ruleResult?.confidence === 'high') return ruleResult;
  const geminiResult = await geminiRoute(brief);
  if (geminiResult) return geminiResult;
  if (ruleResult) return ruleResult;
  return { model: 'flux-max', reason: '기본 이미지 생성 (자동 분류 불확실)', asset_type: 'image', style: 'lifestyle', needs_reference: false, confidence: 'fallback' };
}

export const MODEL_INFO = {
  'nano-banana-pro': { label: 'Nano Banana Pro', icon: '🍌', color: '#FFD700', desc: '4K 제품 사진', provider: 'Higgsfield', type: 'image', input: 'T2I' },
  'flux-max':        { label: 'FLUX.2 Max', icon: '⚡', color: '#8B5CF6', desc: '최상위 정밀도', provider: 'Higgsfield', type: 'image', input: 'T2I' },
  'flux-kontext':    { label: 'FLUX Kontext', icon: '🔮', color: '#A855F7', desc: '에디토리얼/편집', provider: 'Higgsfield', type: 'image', input: 'T2I' },
  'reve':            { label: 'Reve', icon: '🎨', color: '#F59E0B', desc: '아트/크리에이티브', provider: 'Higgsfield', type: 'image', input: 'T2I' },
  'veo3.1':          { label: 'Veo 3.1', icon: '🎬', color: '#4285F4', desc: 'T2V/I2V 최고품질 (5~10분)', provider: 'fal.ai', type: 'video', input: 'T2V/I2V' },
  'veo3.1-fast':     { label: 'Veo 3.1 Fast', icon: '⚡', color: '#60A5FA', desc: 'T2V/I2V 빠른 생성 (1~3분)', provider: 'fal.ai', type: 'video', input: 'T2V/I2V' },
  'veo3.1-flf':      { label: 'Veo 3.1 FLF', icon: '🎞️', color: '#34A853', desc: '시작+끝 프레임 → 사이 영상', provider: 'fal.ai', type: 'video', input: 'FLF' },
  'veo3.1-fast-flf': { label: 'Veo 3.1 Fast FLF', icon: '🎞️', color: '#86EFAC', desc: '시작+끝 프레임 → 사이 영상 (빠름)', provider: 'fal.ai', type: 'video', input: 'FLF' },
  'veo3.1-ref':      { label: 'Veo 3.1 Ref2V', icon: '🎭', color: '#EA4335', desc: '레퍼런스 이미지로 캐릭터 일관성 영상', provider: 'fal.ai', type: 'video', input: 'Ref2V' },
  'kling':           { label: 'Kling v2 Master', icon: '🎥', color: '#06B6D4', desc: 'I2V 최고품질', provider: 'fal.ai', type: 'video', input: 'I2V' },
  'sora2':           { label: 'Sora 2', icon: '🌀', color: '#10A37F', desc: 'I2V 시네마틱', provider: 'Higgsfield', type: 'video', input: 'I2V' },
  'seedance2':       { label: 'Seedance 2', icon: '🎵', color: '#F97316', desc: 'T2V/I2V 오디오 동시생성', provider: 'fal.ai', type: 'video', input: 'T2V/I2V' },
  'flux-2-pro':      { label: 'FLUX.2 Pro', icon: '💎', color: '#7C3AED', desc: '최고 품질 이미지', provider: 'fal.ai', type: 'image', input: 'T2I' },
  'seedream':        { label: 'Seedream 4.5', icon: '🌱', color: '#34D399', desc: '고품질 이미지 생성', provider: 'fal.ai', type: 'image', input: 'T2I' },
};
