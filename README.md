# My-Portfolio

Personal portfolio with **Jarvis**, an AI assistant that answers visitors' questions about my projects and skills. It's one Vercel project: static pages plus one serverless function, no build step.

## Structure

```
index.html            portfolio page
css/style.css         portfolio styles
js/main.js            renders the page from data/profile.json
data/profile.json     ← all content lives here (the page and Jarvis both read it)
jarvis/jarvis.js      chat widget (vanilla JS)
jarvis/jarvis.css     chat widget styles
api/jarvis.js         Vercel Serverless Function: POST /api/jarvis → Claude, streamed
tests/jarvis.test.js  API tests against a mock Claude API (npm test)
vercel.json           function settings + security headers
```

## Editing content

Update `data/profile.json`: name, role, summary, skills, projects, links, and Jarvis's greeting and suggested questions. Jarvis answers only from this file, so anything you add here is something it can talk about. Leave a field empty if you don't want it shown or mentioned.

## Deploying on Vercel

1. In Vercel → Project → Settings → Environment Variables, add **`ANTHROPIC_API_KEY`** (Production, and Preview if you want it there too).
2. Optional: `JARVIS_MODEL` to override the model (default `claude-opus-5-5`).
3. Push to `main`. Vercel installs `@anthropic-ai/sdk` from `package.json` and serves everything else as static files. No framework preset or Root Directory change is needed.

Set a monthly spend limit in the Anthropic Console as well, since `/api/jarvis` is public.

## Local development

```bash
npm install
cp .env.example .env.local       # then put your ANTHROPIC_API_KEY in .env.local (git-ignored)
npm start                        # site + /api/jarvis at http://localhost:3000
npm test                         # API tests, no key needed
```

`npm start` runs `scripts/dev-server.js`, a small local server that mirrors Vercel (static files, `/api/jarvis`, and the `vercel.json` headers) without needing the Vercel CLI. `npx vercel dev` also works if you've linked the folder with `npx vercel link`.

## How Jarvis works

- The browser posts the conversation to `/api/jarvis`. The API key stays on the server.
- The function validates input (≤ 20 turns, ≤ 2,000 characters per message), rejects cross-origin requests, rate-limits each IP (10 requests/minute, per instance), and streams Claude's reply back as newline-delimited JSON.
- The system prompt is built from `data/profile.json` and tells the model not to invent anything that isn't there.
- Server-side refusal fallbacks are on (`fallbacks: "default"`). Remove them in `api/jarvis.js` if you don't want them.

The name and idea are inspired by [OpenJarvis](https://github.com/open-jarvis/OpenJarvis). Jarvis doesn't run OpenJarvis's code, because that framework needs local models and a long-running server, and neither can run on Vercel.
