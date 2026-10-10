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

// ---- Multi-provider AI helper (free-tier friendly, auto-fallback) ----
const oai = (url, keyEnv, model, extra = {}) => ({ type: 'openai', url, key: process.env[keyEnv], model, ...extra });
const PROVIDERS = {
  gemini: {
    type: 'gemini', vision: true, key: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },
  github: oai('https://models.github.ai/inference/chat/completions', 'GITHUB_MODELS_TOKEN',
    process.env.GITHUB_MODEL || 'openai/gpt-4.1', { vision: true }),
  groq: oai('https://api.groq.com/openai/v1/chat/completions', 'GROQ_API_KEY',
    process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct', { vision: true, maxImages: 5 }),
  openrouter: oai('https://openrouter.ai/api/v1/chat/completions', 'OPENROUTER_API_KEY',
    process.env.OPENROUTER_MODEL || 'google/gemma-3-27b-it:free', { vision: true }),
  cerebras: oai('https://api.cerebras.ai/v1/chat/completions', 'CEREBRAS_API_KEY',
    process.env.CEREBRAS_MODEL || 'gpt-oss-120b', { vision: false }),
};
const order = (envName, fallback) => (process.env[envName] || fallback).split(',').map((x) => x.trim()).filter(Boolean);
const VISION_ORDER = order('VISION_ORDER', 'gemini,github,groq,openrouter');
const TEXT_ORDER = order('TEXT_ORDER', 'cerebras,groq,gemini,github,openrouter');
const configured = () => Object.entries(PROVIDERS).filter(([, p]) => p.key).map(([n]) => n);

function parseJson(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('No JSON in response');
  return JSON.parse(text.slice(s, e + 1));
}

async function callGemini(p, { system, text, images, maxTokens }) {
  const parts = [...images.map((data) => ({ inline_data: { mime_type: 'image/jpeg', data } })), { text }];
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${p.model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': p.key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { maxOutputTokens: Math.max(maxTokens, 8000), responseMimeType: 'application/json', temperature: 0.6 },
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  return (d.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('');
}

async function callOpenAICompat(p, { system, text, images, maxTokens }) {
  const imgs = p.maxImages ? images.slice(0, p.maxImages) : images;
  const content = imgs.length
    ? [...imgs.map((data) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } })), { type: 'text', text }]
    : text;
  const r = await fetch(p.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}` },
    body: JSON.stringify({
      model: p.model, max_tokens: maxTokens, temperature: 0.6,
      messages: [{ role: 'system', content: system }, { role: 'user', content }],
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  return d.choices?.[0]?.message?.content || '';
}

async function askAI({ system, text, images = [], maxTokens = 3500 }) {
  const wantsVision = images.length > 0;
  const names = (wantsVision ? VISION_ORDER : TEXT_ORDER).filter((n) => PROVIDERS[n]?.key && (!wantsVision || PROVIDERS[n].vision));
  if (!names.length) throw new Error('No AI provider is configured on the server.');
  let lastErr;
  for (const name of names) {
    const p = PROVIDERS[name];
    try {
      const raw = p.type === 'gemini'
        ? await callGemini(p, { system, text, images, maxTokens })
        : await callOpenAICompat(p, { system, text, images, maxTokens });
      const out = parseJson(raw);
      out._provider = name;
      console.log(`AI ok via ${name} (${p.model})`);
      return out;
    } catch (err) {
      lastErr = err;
      console.error(`AI provider ${name} failed:`, err.message);
    }
  }
  console.error('All providers failed. Last error:', lastErr?.message);
  throw new Error('The AI service is busy or out of free quota. Please try again in a minute.');
}

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
Return ONLY valid JSON, no markdown, in this exact shape:
{"ingredients":[{"name":"string"}],
 "dishes":[{"id":"short-slug","name":"string","emoji":"one emoji","cuisine":"string","description":"one appetising sentence","time_minutes":number,"difficulty":"Easy|Medium|Hard","uses":["ingredient names from the list"],"missing":["items not available"],"match_percent":number}],
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
    res.status(500).json({ error: err.message || 'Something went wrong.' });
  }
});

// ---- 2) Full step-by-step recipe for one dish ----
app.post('/api/recipe', guard, async (req, res) => {
  try {
    const { dish, ingredients = [], diet = [], servings = 2 } = req.body || {};
    if (!dish || typeof dish !== 'string') return res.status(400).json({ error: 'Pick a dish first.' });

    const system = `You are a patient cooking teacher writing a recipe for a home cook. Give clear, complete, beginner-friendly steps with sensible quantities for the requested servings, heat levels, and visual/aroma cues for doneness.
Return ONLY valid JSON, no markdown, in this exact shape:
{"name":"string","emoji":"one emoji","servings":number,"total_time_minutes":number,"difficulty":"Easy|Medium|Hard",
 "ingredients":[{"item":"string","amount":"string like 2 tbsp","have":true|false}],
 "steps":[{"title":"short title","instruction":"2-4 clear sentences","timer_minutes":number or null,"tip":"optional short tip or empty string"}],
 "tips":["1-3 short general tips, e.g. storage or swaps"]}
"have" is true when the item is in the person's available ingredients or is a basic staple (salt, pepper, oil, water, sugar). Put prep (washing, chopping) in the first steps. Use timer_minutes only for steps with real waiting/cooking time.`;

    const text = `Dish: ${dish}
Servings: ${servings}
${dietLine(diet)}
Available ingredients: ${ingredients.length ? ingredients.join(', ') : 'unknown'}`;

    const out = await askAI({ system, text, maxTokens: 4000 });
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Something went wrong.' });
  }
});

app.listen(PORT, () => console.log(`PantryChef running on port ${PORT}. Providers with keys: ${configured().join(', ') || 'none'}`));
