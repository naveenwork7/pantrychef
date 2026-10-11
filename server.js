import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.send('ok'));
app.get('/api/config', (_req, res) => res.json({ passwordRequired: !!APP_PASSWORD }));

// ---- Simple protection: optional password + per-IP rate limit ----
const hits = new Map();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 60;

function guard(req, res, next) {
  if (!configured().length) return res.status(500).json({ error: 'Server has no AI API key configured.' });
  if (APP_PASSWORD && req.get('x-app-password') !== APP_PASSWORD) {
    return res.status(401).json({ error: 'Wrong or missing password.' });
  }
  const now = Date.now();
  const arr = (hits.get(req.ip) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) {
    return res.status(429).json({ error: 'Too many requests. Try again in a little while.' });
  }
  arr.push(now);
  hits.set(req.ip, arr);
  next();
}

// ---- Multi-provider AI helper (free-tier friendly, auto-discovers current models, auto-fallback) ----
const env = (n) => (process.env[n] || '').trim();
const list = (...xs) => [...new Set(xs.flat().filter(Boolean))];
const githubKey = env('GITHUB_MODELS_TOKEN');
const PROVIDERS = {
  gemini: {
    type: 'gemini', key: env('GEMINI_API_KEY'), override: env('GEMINI_MODEL'),
    visionModels: ['gemini-flash-latest'], textModels: ['gemini-flash-latest'],
  },
  github: {
    type: 'openai', url: 'https://models.github.ai/inference/chat/completions', github: true, key: githubKey, override: env('GITHUB_MODEL'),
    visionModels: ['openai/gpt-4.1', 'openai/gpt-4o', 'openai/gpt-4o-mini'],
    textModels: ['openai/gpt-4.1', 'openai/gpt-4o-mini'],
  },
  github_legacy: {
    type: 'openai', url: 'https://models.inference.ai.azure.com/chat/completions', key: githubKey, override: '',
    visionModels: ['gpt-4o', 'gpt-4o-mini'], textModels: ['gpt-4o-mini', 'gpt-4o'],
  },
  groq: {
    type: 'openai', url: 'https://api.groq.com/openai/v1/chat/completions', key: env('GROQ_API_KEY'), maxImages: 3,
    override: env('GROQ_MODEL'),
    visionModels: ['qwen/qwen3.8-27b', 'meta-llama/llama-4-scout-17b-16e-instruct'],
    textModels: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
  },
  openrouter: {
    type: 'openai', url: 'https://openrouter.ai/api/v1/chat/completions', key: env('OPENROUTER_API_KEY'), override: env('OPENROUTER_MODEL'),
    visionModels: [], textModels: [],
  },
  cerebras: {
    type: 'openai', url: 'https://api.cerebras.ai/v1/chat/completions', key: env('CEREBRAS_API_KEY'), override: env('CEREBRAS_MODEL'),
    visionModels: [], textModels: ['gpt-oss-120b', 'llama-3.3-70b', 'qwen-3-32b', 'llama3.1-8b'],
  },
};
const order = (name, fallback) => (env(name) || fallback).split(',').map((x) => x.trim()).filter(Boolean);
const VISION_ORDER = order('VISION_ORDER', 'gemini,github,groq,openrouter,github_legacy');
const TEXT_ORDER = order('TEXT_ORDER', 'cerebras,groq,gemini,github,openrouter,github_legacy');
const configured = () => Object.entries(PROVIDERS).filter(([, p]) => p.key).map(([n]) => n);

const redact = (t) => {
  let out = String(t);
  for (const p of Object.values(PROVIDERS)) if (p.key && p.key.length > 6) out = out.split(p.key).join('***');
  return out.replace(/\s+/g, ' ').slice(0, 240);
};
class HttpErr extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  if (!r.ok) throw new HttpErr(r.status, `HTTP ${r.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { throw new Error(`Non-JSON reply: ${text.slice(0, 80)}`); }
}

// Ask each provider which models it offers right now, so we never depend on stale model names.
async function discover(name, p, vision) {
  const bearer = { authorization: `Bearer ${p.key}` };
  if (name === 'gemini') {
    const d = await getJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { 'x-goog-api-key': p.key });
    const score = (id) => {
      const m = id.match(/gemini-(\d+(?:\.\d+)?)/);
      return (m ? parseFloat(m[1]) * 10 : 0) - (/preview/.test(id) ? 1 : 0) - (/lite/.test(id) ? 2 : 0);
    };
    return { ids: (d.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace('models/', ''))
      .filter((id) => /gemini-.*flash/.test(id) && !/(image|tts|audio|live|native|robotics|computer|embedding|exp|thinking)/i.test(id))
      .sort((a, b) => score(b) - score(a)), authoritative: true };
  }
  if (name === 'groq') {
    const d = await getJson('https://api.groq.com/openai/v1/models', bearer);
    const ids = (d.data || []).map((m) => m.id).filter((id) => !/(whisper|tts|guard|playai|orpheus|embed|compound|safeguard|distil)/i.test(id));
    return { ids: vision ? ids.filter((id) => /(vision|qwen|llama-4|maverick|scout|-vl|pixtral|llava|gemma-3)/i.test(id)) : ids };
  }
  if (name === 'cerebras') {
    const d = await getJson('https://api.cerebras.ai/v1/models', bearer);
    return { ids: (d.data || []).map((m) => m.id) };
  }
  if (name === 'openrouter') {
    const d = await getJson('https://openrouter.ai/api/v1/models');
    const ids = (d.data || [])
      .filter((m) => Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0 && !/(router|\/auto)/.test(m.id))
      .filter((m) => (m.architecture?.output_modalities || ['text']).includes('text') && !/(image-preview|image-generation)/.test(m.id))
      .filter((m) => !vision || (m.architecture?.input_modalities || []).includes('image'))
      .sort((a, b) => famRank(b.id) - famRank(a.id) || (b.context_length || 0) - (a.context_length || 0))
      .map((m) => m.id);
    return { ids, authoritative: true };
  }
  if (name === 'github') {
    const d = await getJson('https://models.github.ai/catalog/models', { ...bearer, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' });
    const ids = (Array.isArray(d) ? d : []).filter((m) => !vision || (m.supported_input_modalities || []).includes('image')).map((m) => m.id);
    return { ids };
  }
  return { ids: [] };
}

const famRank = (id) => (/(gemma|llama|mistral|qwen|pixtral|nemotron|glm|phi)/i.test(id) ? 1 : 0);

// models that returned 'not found / not allowed' are skipped for a while
const badModels = new Map();
const markBad = (name, model, mins) => badModels.set(`${name}:${model}`, Date.now() + mins * 60000);
const isBad = (name, model) => (badModels.get(`${name}:${model}`) || 0) > Date.now();

const modelCache = new Map();
async function modelsFor(name, vision) {
  const key = `${name}:${vision}`;
  const hit = modelCache.get(key);
  if (hit && Date.now() - hit.t < 30 * 60 * 1000) return hit.v;
  const p = PROVIDERS[name];
  const base = vision ? p.visionModels : p.textModels;
  let found = null;
  try { found = await discover(name, p, vision); }
  catch (err) { console.error(`Model discovery failed for ${name}: ${redact(err.message)}`); }
  let models;
  if (found && found.ids.length) {
    const have = new Set(found.ids);
    models = found.authoritative
      ? list(p.override, found.ids, base)
      : list(p.override, base.filter((m) => have.has(m)), found.ids, base);
    modelCache.set(key, { t: Date.now(), v: models });
  } else {
    models = list(p.override, base);
  }
  return models.filter((m) => !isBad(name, m));
}

function parseJson(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error(`Reply was not JSON: ${text.slice(0, 60)}`);
  return JSON.parse(text.slice(s, e + 1));
}

async function readJson(r) {
  const text = await r.text();
  if (!r.ok) throw new HttpErr(r.status, `HTTP ${r.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { throw new Error(`Provider sent a non-JSON reply: ${text.slice(0, 80)}`); }
}

async function callGemini(p, model, { system, text, images, maxTokens }) {
  const parts = [...images.map((data) => ({ inline_data: { mime_type: 'image/jpeg', data } })), { text }];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const send = (noThinking) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': p.key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        maxOutputTokens: Math.max(maxTokens, 8000), responseMimeType: 'application/json', temperature: 0.6,
        ...(noThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    }),
    signal: AbortSignal.timeout(50000),
  });
  let r = await send(true);
  if (r.status === 400) r = await send(false); // this model may not allow turning thinking off
  const d = await readJson(r);
  return (d.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('');
}

async function callOpenAICompat(p, model, { system, text, images, maxTokens }) {
  const imgs = p.maxImages ? images.slice(0, p.maxImages) : images;
  const content = imgs.length
    ? [...imgs.map((data) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } })), { type: 'text', text }]
    : text;
  const r = await fetch(p.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', authorization: `Bearer ${p.key}`,
      ...(p.github ? { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } : {}),
    },
    body: JSON.stringify({
      model, max_tokens: Math.max(maxTokens, 5000), temperature: 0.6,
      messages: [{ role: 'system', content: system }, { role: 'user', content }],
    }),
    signal: AbortSignal.timeout(50000),
  });
  const d = await readJson(r);
  return d.choices?.[0]?.message?.content || '';
}

const callProvider = (p, model, args) => (p.type === 'gemini' ? callGemini(p, model, args) : callOpenAICompat(p, model, args));
// Providers that rejected our key / ran out of quota are paused for a while
const providerBad = new Map();
const provBad = (n) => (providerBad.get(n) || 0) > Date.now();
const STAGGER_MS = Number(process.env.STAGGER_MS) || 7000;
const slowUntil = new Map(); // providers that were overloaded or slow recently go to the back for 5 minutes
const isSlow = (n) => (slowUntil.get(n) || 0) > Date.now();

// Hedged requests: start the best provider; if it is slow or fails, start the next one right away
// (without cancelling the first). The first valid answer wins, so one overloaded provider never blocks the app.
async function askAI({ system, text, images = [], maxTokens = 3500 }) {
  const wantsVision = images.length > 0;
  const names = (wantsVision ? VISION_ORDER : TEXT_ORDER).filter((n) => PROVIDERS[n]?.key && !provBad(n))
    .sort((x, y) => Number(isSlow(x)) - Number(isSlow(y)));
  if (!names.length) {
    const e = new Error('No working AI provider is available right now. Check your API keys on Render.');
    e.detail = `Keys found: ${configured().join(', ') || 'none'}`;
    throw e;
  }
  const lists = await Promise.all(names.map((n) => modelsFor(n, wantsVision).then((m) => m.slice(0, 3))));
  const attempts = [];
  for (let round = 0; round < 3; round++) names.forEach((n, k) => { if (lists[k][round]) attempts.push({ name: n, model: lists[k][round] }); });
  if (!attempts.length) throw new Error('No AI model is available for this request.');

  return new Promise((resolve, reject) => {
    const failures = [];
    let next = 0, running = 0, finished = false;
    const finish = (fn, v) => { if (finished) return; finished = true; clearTimeout(deadline); fn(v); };
    const fail = () => {
      const e = new Error('Could not get an answer from any AI provider.');
      e.detail = failures.slice(0, 8).join('\n'); finish(reject, e);
    };
    const deadline = setTimeout(() => { failures.push('Stopped: taking too long'); fail(); }, 95000);

    const launch = () => {
      if (finished || next >= attempts.length) return false;
      const a = attempts[next++]; const p = PROVIDERS[a.name]; running++;
      let settled = false;
      const settle = () => { if (settled) return; settled = true; running--; if (!finished && !launch() && running === 0) fail(); };
      setTimeout(() => { if (!settled && !finished) launch(); }, STAGGER_MS); // slow? bring in a backup
      callProvider(p, a.model, { system, text, images, maxTokens })
        .then((raw) => {
          const out = parseJson(raw);
          out._provider = `${a.name}:${a.model}`;
          console.log(`AI ok via ${a.name} (${a.model})`);
          finish(resolve, out);
        })
        .catch((err) => {
          const msg = redact(err.message);
          failures.push(`${a.name} (${a.model}): ${msg}`);
          console.error(`AI ${a.name} (${a.model}) failed: ${msg}`);
          if ([500, 502, 503, 504].includes(err.status) || err.name === 'TimeoutError') slowUntil.set(a.name, Date.now() + 5 * 60000);
          if (err.status === 404 || (a.name === 'openrouter' && [400, 403, 404].includes(err.status))) markBad(a.name, a.model, 60);
          if (err.status === 401 || err.status === 429 || (err.status === 403 && a.name !== 'openrouter')) providerBad.set(a.name, Date.now() + 10 * 60000);
        })
        .finally(settle);
      return true;
    };
    launch();
  });
}

// Open /api/diagnose in your browser to see which providers work (add ?pw=YOURPASSWORD if you set one)
const TINY_JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAwADADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDPooorhPqAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAP/2Q==';
app.get('/api/diagnose', async (req, res) => {
  if (APP_PASSWORD && req.query.pw !== APP_PASSWORD) return res.status(401).json({ error: 'Add ?pw=YOUR_PASSWORD' });
  const out = { keysFound: configured(), tests: [] };
  const sys = 'Reply with only this JSON: {"ok":true}';
  for (const [name, p] of Object.entries(PROVIDERS)) {
    if (!p.key) { out.tests.push({ provider: name, status: 'no key set' }); continue; }
    for (const [kind, images] of [['text', []], ['vision', [TINY_JPEG]]]) {
      if (kind === 'text' && name === 'github_legacy') continue;
      const models = await modelsFor(name, kind === 'vision');
      if (!models.length) { out.tests.push({ provider: name, kind, status: 'no models available for this' }); continue; }
      try {
        const raw = await callProvider(p, models[0], { system: sys, text: kind === 'vision' ? 'What colour is the image? Reply only {"ok":true}' : 'Go.', images, maxTokens: 300 });
        out.tests.push({ provider: name, kind, model: models[0], status: 'OK', sample: redact(raw).slice(0, 60) });
      } catch (err) {
        out.tests.push({ provider: name, kind, model: models[0], otherModels: models.slice(1, 4), status: 'FAILED', error: redact(err.message) });
      }
    }
  }
  res.json(out);
});

const INDIAN_ENGLISH = `LANGUAGE: Write everything in simple, warm Indian English, the way a friendly home cook in India would explain to a family member. Short, clear sentences. Use Indian kitchen words naturally: kadhai, tawa, pressure cooker, tadka, katori, masala, "on low / medium / high flame", "till the raw smell goes", "till it turns golden brown", "till the oil leaves the sides". Use Indian vocabulary: coriander (not cilantro), curd (not yogurt), brinjal, capsicum, ladies finger, maida, jaggery, ghee, haldi/turmeric. Metric measures (grams, ml) and spoons (tsp, tbsp); say "a pinch" or "a handful" where natural. Never use American terms like stovetop, skillet, broil, zucchini, bell pepper, eggplant, scallion.`;

const dietLine = (diet) => (Array.isArray(diet) && diet.length ? `Dietary requirements (strict): ${diet.join(', ')}.` : 'No dietary restrictions.');

// ---- 1) Look at photos / ingredient list and suggest dishes ----
app.post('/api/suggest', guard, async (req, res) => {
  try {
    const { images = [], ingredients = [], notes = '', diet = [], cuisine = 'any', servings = 2, maxTime = 0 } = req.body || {};
    if (!Array.isArray(images) || images.length > 6) return res.status(400).json({ error: 'Add up to 6 photos.' });
    if (images.some((i) => typeof i !== 'string' || i.length > 6_000_000)) return res.status(400).json({ error: 'A photo is too large.' });
    if (!images.length && !ingredients.length && !String(notes).trim()) {
      return res.status(400).json({ error: 'Add a photo or type some ingredients first.' });
    }

    const system = `You are a practical, friendly home-cooking assistant. You look at photos of a person's fridge, pantry, counter or groceries and identify the edible ingredients, then suggest dishes they can cook.
Rules:
- Only list ingredients you can actually see or that the person typed. Be specific (e.g. "red onion", not "vegetable"). If unsure, say so in the name, e.g. "green leaves (coriander?)".
- Assume basic pantry staples exist (salt, pepper, cooking oil, water, sugar) but NOT other items. Anything else needed goes in "missing".
- Suggest 6 dishes, best matches first. Prefer dishes that use mostly what is available (aim for at most 2 missing items per dish).
- Obey dietary requirements strictly. Respect the cuisine and time limit if given.
- If the photos contain no food, return an empty ingredients list, no dishes, and explain in "note".
${INDIAN_ENGLISH}
Dish names: use the commonly known name (e.g. "Aloo Gobi", "Poha").
Return ONLY valid JSON, no markdown, in this exact shape:
{"ingredients":[{"name":"string"}],
 "dishes":[{"id":"short-slug","name":"string","emoji":"one emoji","photo_search":"simple Wikipedia-style title of the dish, e.g. Poha","cuisine":"string","description":"one appetising sentence in Indian English","time_minutes":number,"difficulty":"Easy|Medium|Hard","uses":["ingredient names from the list"],"missing":["items not available"],"match_percent":number}],
 "note":"optional short message for the user or empty string"}`;

    const text = `${dietLine(diet)}
Cuisine preference: ${cuisine}.
Servings: ${servings}.
Maximum cooking time: ${maxTime ? maxTime + ' minutes' : 'no limit'}.
Ingredients the person typed/confirmed: ${ingredients.length ? ingredients.join(', ') : 'none'}.
Extra notes: ${String(notes).slice(0, 500) || 'none'}.
${images.length ? 'Photos are attached above.' : 'No photos; use the typed ingredients.'}`;

    const out = await askAI({ system, text, images, maxTokens: 3500 });
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Something went wrong.', detail: err.detail || '' });
  }
});

// ---- 2) Full step-by-step recipe for one dish ----
app.post('/api/recipe', guard, async (req, res) => {
  try {
    const { dish, ingredients = [], diet = [], servings = 2 } = req.body || {};
    if (!dish || typeof dish !== 'string') return res.status(400).json({ error: 'Pick a dish first.' });

    const system = `You are a patient, friendly cooking teacher writing a recipe for a home cook in India. Give clear, complete, beginner-friendly steps with sensible quantities for the requested servings. Say exactly which flame to use and what the person should see, smell or hear when a step is done.
${INDIAN_ENGLISH}
Return ONLY valid JSON, no markdown, in this exact shape:
{"name":"string","emoji":"one emoji","photo_search":"simple Wikipedia-style dish title","summary":"one friendly sentence","servings":number,"total_time_minutes":number,"difficulty":"Easy|Medium|Hard",
 "ingredients":[{"item":"short plain name like onion","amount":"string like 2 medium or 1 tsp","have":true|false}],
 "steps":[{"title":"short title (3-5 words)","action":"prep|chop|heat|temper|saute|fry|boil|simmer|pressure|mix|grind|knead|steam|roast|rest|serve","instruction":"2-3 short, clear sentences","flame":"off|low|medium|high","timer_minutes":number or null,"uses":[{"item":"short plain name like onion","amount":"how much to add in this step, with how it is cut"}],"cue":"what to look, smell or listen for, short","tip":"optional short tip or empty string"}],
 "tips":["1-3 short general tips, e.g. storage or swaps"]}
Rules: "have" is true when the item is in the person's available ingredients or a basic staple (salt, pepper, oil, water, sugar). Put washing and chopping in the first step(s). Each step "uses" lists only ingredients added in that step (empty list if none); use the same item names as in "ingredients". Use timer_minutes only for steps with real waiting or cooking time. Keep 6 to 10 steps.`;

    const text = `Dish: ${dish}
Servings: ${servings}
${dietLine(diet)}
Available ingredients: ${ingredients.length ? ingredients.join(', ') : 'unknown'}`;

    const out = await askAI({ system, text, maxTokens: 5000 });
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Something went wrong.', detail: err.detail || '' });
  }
});

app.listen(PORT, () => console.log(`PantryChef running on port ${PORT}. Providers with keys: ${configured().join(', ') || 'none'}`));
