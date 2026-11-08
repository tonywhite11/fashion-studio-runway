// Fashion Studio Runway backend (Cloudflare Worker)
//   POST /share         save an outfit, get a short code like "STAR-42" (kept 30 days)
//   GET  /share/:code   fetch a shared outfit
//   POST /narrate       Claude looks at the model(s) and writes the announcer's lines; ElevenLabs speaks them
//   GET  /health        what is configured
// Secrets (wrangler secret put): ANTHROPIC_API_KEY, ELEVENLABS_API_KEY
// Vars (wrangler.toml): ALLOWED_ORIGINS, ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL, NARRATOR_MODEL, DAILY_NARRATIONS, PER_IP_NARRATIONS
// Local dev without keys: MOCK_AI=1 in .dev.vars returns a template narration and no audio.
import Anthropic from '@anthropic-ai/sdk';

const SHARE_TTL = 60 * 60 * 24 * 30; // 30 days
const MAX_SHARE_BYTES = 4_000_000;
const MAX_IMAGE_CHARS = 900_000; // base64 chars per model snapshot
const WORDS = ['STAR', 'MOON', 'SUN', 'ROSE', 'KITE', 'LOTUS', 'PEARL', 'GEM', 'BOW', 'TULIP', 'SILK', 'GLOW', 'SPARK', 'BLOOM', 'HEART', 'CLOUD', 'RAIN', 'SNOW', 'LEAF', 'PEACH', 'PLUM', 'BERRY', 'CANDY', 'TIARA', 'DANCE', 'SHINE', 'JEWEL', 'RUBY', 'JADE', 'CORAL', 'MANGO', 'LILY', 'DAISY', 'FOX', 'TIGER', 'PANDA', 'BUNNY', 'DIYO', 'MOMO', 'HIMAL'];

const SYSTEM = `You are the cheerful announcer of a kids' fashion show in a dress-up game played by 8-year-old girls.
You are given a snapshot of each model on the runway plus the game's names for what she is wearing.
Write the announcer's lines, which will be read aloud by a text-to-speech voice.

Rules:
- 2 or 3 short sentences in total, under 45 words (with two models, up to 4 sentences and 60 words). Warm, excited, and kind, like a real runway host.
- Introduce each model by her name (or "our designer" if no name is given), then describe her outfit: use the dress name exactly as given, and mention its main color and one pattern or sticker you can actually see, plus one accessory or her hairstyle. Pick the highlights; do not list everything.
- Treat traditional outfits (for example Kurta Suruwal, Gunyu Cholo, Haku Patasi, Hanbok) with respect and name them correctly.
- Only talk about clothes, hair, accessories, and the show. Never comment on bodies, weight, skin, or faces.
- If there are two models, introduce both and end with a line about them walking together.
- Plain sentences only: no emoji, no lists, no stage directions, no quotation marks.
- Everything you write is read aloud to the children. Never add notes, explanations, or questions, and never mention pictures, snapshots, or missing information. If a picture is missing, just use the names you were given.`;

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    try {
      if (url.pathname === '/health') return json({ ok: true, share: !!env.SHARES, narrator: narratorReady(env), voice: !!env.ELEVENLABS_API_KEY, mock: env.MOCK_AI === '1' }, 200, cors);
      if (url.pathname === '/share' && req.method === 'POST') return await createShare(req, env, cors);
      const m = url.pathname.match(/^\/share\/([A-Za-z0-9-]{3,16})$/);
      if (m && req.method === 'GET') return await getShare(m[1], env, cors);
      if (url.pathname === '/narrate' && req.method === 'POST') return await narrate(req, env, cors);
      return json({ error: 'not_found' }, 404, cors);
    } catch (e) {
      console.error(e);
      return json({ error: 'server_error' }, 500, cors);
    }
  }
};

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : (allowed[0] || ''),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
const json = (obj, status, cors) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const narratorReady = env => env.MOCK_AI === '1' || !!env.ANTHROPIC_API_KEY;
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const today = () => new Date().toISOString().slice(0, 10);

async function readJson(req, maxBytes) {
  const len = +(req.headers.get('Content-Length') || 0);
  if (len > maxBytes) return null;
  const text = await req.text();
  if (text.length > maxBytes) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/* ---------- sharing ---------- */
function validOutfit(o) {
  return o && typeof o === 'object' && o.cfg && typeof o.cfg === 'object' && typeof o.cfg.dress === 'string' &&
    o.design && typeof o.design.deco === 'string' && o.design.deco.startsWith('data:image/png;base64,') &&
    (!o.thumb || (typeof o.thumb === 'string' && o.thumb.startsWith('data:image/')));
}
async function createShare(req, env, cors) {
  if (!env.SHARES) return json({ error: 'sharing_not_configured' }, 503, cors);
  const body = await readJson(req, MAX_SHARE_BYTES);
  const o = body && body.outfit;
  if (!validOutfit(o)) return json({ error: 'bad_outfit' }, 400, cors);
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  if (!(await underLimit(env, `rl:share:${ip}:${today()}`, 60))) return json({ error: 'too_many' }, 429, cors);
  const clean = {
    cfg: o.cfg, design: { bg: o.design.bg ?? null, deco: o.design.deco }, thumb: o.thumb || null,
    name: typeof o.name === 'string' ? o.name.slice(0, 18) : '', t: Date.now()
  };
  for (let i = 0; i < 8; i++) {
    const word = WORDS[crypto.getRandomValues(new Uint32Array(1))[0] % WORDS.length];
    const num = 10 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90);
    const code = `${word}-${num}`;
    const key = 'share:' + normCode(code);
    if (await env.SHARES.get(key)) continue;
    await env.SHARES.put(key, JSON.stringify(clean), { expirationTtl: SHARE_TTL });
    return json({ code, expiresDays: 30 }, 200, cors);
  }
  return json({ error: 'try_again' }, 503, cors);
}
async function getShare(code, env, cors) {
  if (!env.SHARES) return json({ error: 'sharing_not_configured' }, 503, cors);
  const v = await env.SHARES.get('share:' + normCode(code));
  if (!v) return json({ error: 'not_found' }, 404, cors);
  return new Response(v, { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
}

// Simple daily counters in KV (eventually consistent: fine as a spending guard, not exact)
async function underLimit(env, key, max) {
  if (!env.SHARES) return true;
  const n = +(await env.SHARES.get(key) || 0);
  if (n >= max) return false;
  await env.SHARES.put(key, String(n + 1), { expirationTtl: 60 * 60 * 48 });
  return true;
}

/* ---------- narration ---------- */
const str = (v, n = 60) => (typeof v === 'string' ? v.slice(0, n) : '');
function cleanModels(list) {
  if (!Array.isArray(list)) return null;
  const out = list.slice(0, 2).map(m => ({
    name: str(m && m.name, 18),
    dress: str(m && m.dress),
    hairstyle: str(m && m.hairstyle),
    hairColor: str(m && m.hairColor, 30),
    accessories: Array.isArray(m && m.accessories) ? m.accessories.slice(0, 8).map(a => str(a, 30)).filter(Boolean) : [],
    shoes: str(m && m.shoes),
    expression: str(m && m.expression, 20),
    image: typeof (m && m.image) === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(m.image) && m.image.length <= MAX_IMAGE_CHARS ? m.image : null
  }));
  return out.length ? out : null;
}
function describe(models, theme) {
  const lines = models.map((m, i) => `Model ${i + 1}: name: ${m.name || '(no name given)'}; dress: ${m.dress}; hairstyle: ${m.hairstyle}${m.hairColor ? ' (' + m.hairColor + ')' : ''}; accessories: ${m.accessories.join(', ') || 'none'}; shoes: ${m.shoes}; expression: ${m.expression}.`);
  return `Runway stage: ${theme || 'Classic'}.\n${lines.join('\n')}\nThe picture${models.length > 1 ? 's above show' : ' above shows'} the model${models.length > 1 ? 's' : ''} in the same order. Write the announcer's lines now.`;
}
function templateText(models, theme) {
  const who = m => m.name || 'our designer';
  const parts = [`Welcome to the ${theme || 'Fashion Studio'} runway!`]; // keep in sync with templateText in ../index.html
  models.forEach(m => {
    const acc = m.accessories.length ? `, with ${m.accessories.slice(0, 2).join(' and ')}` : '';
    parts.push(`Here comes ${who(m)} in a beautiful ${m.dress}${acc}${m.hairstyle ? ', with her hair in a ' + m.hairstyle.toLowerCase() : ''}!`);
  });
  parts.push(models.length > 1 ? 'Give it up for these two amazing designers!' : 'Give it up for our amazing designer!');
  return parts.join(' ');
}

async function narrate(req, env, cors) {
  if (!narratorReady(env)) return json({ error: 'narrator_not_configured' }, 503, cors);
  const body = await readJson(req, 2_500_000);
  const models = cleanModels(body && body.models);
  if (!models) return json({ error: 'bad_request' }, 400, cors);
  const theme = str(body.theme, 40);

  let text;
  if (env.MOCK_AI === '1') {
    text = templateText(models, theme);
  } else {
    const ip = req.headers.get('CF-Connecting-IP') || 'local';
    if (!(await underLimit(env, `rl:narr:all:${today()}`, +(env.DAILY_NARRATIONS || 80)))) return json({ error: 'daily_limit' }, 429, cors);
    if (!(await underLimit(env, `rl:narr:${ip}:${today()}`, +(env.PER_IP_NARRATIONS || 40)))) return json({ error: 'too_many' }, 429, cors);
    text = await claudeNarration(env, models, theme);
    if (!text) return json({ error: 'narration_failed' }, 502, cors);
  }

  let audio = null;
  if (body.voice !== false && env.ELEVENLABS_API_KEY && env.MOCK_AI !== '1') audio = await speak(env, text);
  return json({ text, audio, mock: env.MOCK_AI === '1' }, 200, cors);
}

async function claudeNarration(env, models, theme) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 25_000 });
  const content = [];
  for (const m of models) {
    if (!m.image) continue;
    const [, mediaType, data] = m.image.match(/^data:(image\/[a-z]+);base64,(.*)$/);
    content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
  }
  content.push({ type: 'text', text: describe(models, theme) });
  try {
    const response = await client.beta.messages.create({
      model: env.NARRATOR_MODEL || 'claude-opus-5-5',
      max_tokens: 2000,
      system: SYSTEM,
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content }]
    });
    if (response.stop_reason === 'refusal') return templateText(models, theme);
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join(' ').replace(/\s+/g, ' ').trim();
    return text || templateText(models, theme);
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) console.error('Anthropic rate limited');
    else if (e instanceof Anthropic.AuthenticationError) console.error('Anthropic API key is invalid');
    else if (e instanceof Anthropic.APIError) console.error(`Anthropic API error ${e.status}: ${e.message}`);
    else console.error(e);
    return templateText(models, theme); // the show still gets an announcer
  }
}

async function speak(env, text) {
  for (let attempt = 0; attempt < 2; attempt++) { // one retry: a recorded voice beats the device's robotic one
    const audio = await speakOnce(env, text);
    if (audio) return audio;
  }
  return null;
}
async function speakOnce(env, text) {
  const voice = env.ELEVENLABS_VOICE_ID;
  if (!voice) return null;
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_64`, {
      method: 'POST',
      headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5' })
    });
    if (!r.ok) { console.error('ElevenLabs error', r.status, (await r.text()).slice(0, 200)); return null; }
    const bytes = new Uint8Array(await r.arrayBuffer());
    let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return 'data:audio/mpeg;base64,' + btoa(bin);
  } catch (e) { console.error('ElevenLabs request failed', e); return null; }
}
