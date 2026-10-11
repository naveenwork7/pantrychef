# PantryChef

Add photos of your ingredients (paste, drop, upload or camera) and get dishes you can cook, then follow a step-by-step cooking mode with timers.

## AI providers
Reading photos (needs vision): Gemini, GitHub Models, Groq, OpenRouter (free vision models), then GitHub legacy endpoint.
Writing recipes (text): Cerebras, then Groq, Gemini, GitHub Models, OpenRouter.
Only providers with a key set are used; if one fails or hits its free limit, the next one is tried.
Troubleshooting: open https://YOUR-APP.onrender.com/api/diagnose (add ?pw=PASSWORD if set) to test every provider.
Env vars: GEMINI_API_KEY, GITHUB_MODELS_TOKEN (needs "Models: read" permission), GROQ_API_KEY, OPENROUTER_API_KEY, CEREBRAS_API_KEY.

## Run locally
    npm install
    GEMINI_API_KEY=... npm start
Open http://localhost:3000

## Deploy on Render
1. Push this folder to GitHub.
2. Render > New > Web Service > connect the repo (build `npm install`, start `npm start`).
3. Add the env vars above, plus APP_PASSWORD (recommended).
4. Deploy and open your https://<name>.onrender.com link.

Model names change often, so the server asks each provider which models it currently offers (cached 30 minutes) instead of hardcoding them. You can still force one with GEMINI_MODEL, GITHUB_MODEL, GROQ_MODEL, OPENROUTER_MODEL or CEREBRAS_MODEL.

## Features
- Recipes are written in simple Indian English (kadhai, tawa, tadka, flame levels, curd, coriander).
- Food photos for dishes and ingredients come from Wikipedia (free, no key needed).
- Interactive cooking mode: gather-ingredients checklist, tap-to-add ingredients per step, flame meter,
  animated step visuals, timers that keep running across steps, swipe or arrow keys to move,
  read-aloud (en-IN voice) and voice commands ("next", "back", "repeat", "start timer").

## Design
Dark-first glass UI with a light theme toggle, bento-style home screen, photo-first dish cards with match rings,
floating bottom bar, animated gradient background, smooth step transitions (View Transitions API where supported),
Instrument Serif + Bricolage Grotesque + Manrope fonts, and inline SVG icons (no extra downloads).
