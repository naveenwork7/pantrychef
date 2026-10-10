# PantryChef

Add photos of your ingredients (paste, drop, upload or camera) and get dishes you can cook, then follow a step-by-step cooking mode with timers.

## AI providers
Reading photos (needs vision): Gemini, then GitHub Models, Groq, OpenRouter.
Writing recipes (text): Cerebras, then Groq, Gemini, GitHub Models, OpenRouter.
Only providers with a key set are used; if one fails or hits its free limit, the next one is tried.
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
