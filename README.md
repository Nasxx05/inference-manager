# AgentFund

A budget-aware AI task planner and prompt compiler.

Describe what you want to accomplish, choose a target model, a quality preference and a CREDIT
budget. AgentFund analyzes the task, estimates the inference cost, checks it against your budget,
optimizes scope when needed, and produces an execution-ready prompt you can copy and run yourself.

**AgentFund never executes your task.** The prompt is the product.

## How it works

1. **Describe the task.** AgentFund classifies it and detects what kind of work it is.
2. **Answer a few clarifying questions.** Before anything final is generated, you get 3–6
   questions specific to *your* task — not a fixed generic list. A portfolio site is asked about
   audience, design direction, stack and pages; a tic-tac-toe game is asked about single vs two
   player, visual style, win/draw handling and extras.
3. **Review the plan.** Cost estimate, feasibility against your budget, and model recommendation.
4. **Copy the prompt.** The internal model writes it from your answers, shaped for the model you
   selected.

Pick as many options as apply on any question — they are combined into that answer, and you can
type your own alongside them. Questions where only one answer makes sense (language, tone,
duration) are exclusive: choosing one replaces the other.

Skipping is always allowed. Every question carries a sensible default, so if you skip you still
get a usable prompt — just less detailed. Skipped questions appear in the prompt under
**ASSUMED DEFAULTS** so the executor can restate them and you can correct them.

The clarifying step only affects the prompt. Cost estimation, feasibility and model
recommendation are unchanged whether you answer or skip.

## Quick start

Run both halves. The backend must be up, because it writes the prompts.

```bash
# Terminal 1 - backend (owns the AI credentials, does the slow work)
cd server
npm install
npm run build
npm start          # listens on http://localhost:10000

# Terminal 2 - frontend
npm install
npm run dev
```

Open http://localhost:3000.

```bash
npm test           # 109 tests
npm run build
```

## How it is deployed

AgentFund ships as two services. The split exists because writing a prompt takes
a few minutes, and a serverless function would time out long before it finished.

| | Frontend | Backend |
|---|---|---|
| Platform | Vercel | Render |
| Code | repo root | `server/` |
| Type | Next.js, fully static | Express web service |
| Holds | no credentials | `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` |
| Does | UI, cost math, model choice | task analysis, prompt writing |

The browser calls the backend **directly**, so Vercel is never in the path of the
slow request and no platform timeout applies.

### Backend on Render

1. Create a **Web Service** from this repo.
2. Set **Root Directory** to `server`.
3. Build Command: `npm install && npm run build`
4. Start Command: `npm start`
5. Add these environment variables:

   | Name | Value |
   |---|---|
   | `AI_BASE_URL` | provider base URL, e.g. `https://api.orbio.so/api/v1` |
   | `AI_API_KEY` | key for the internal planner |
   | `AI_MODEL` | model id, e.g. `tencent/hy4-preview` |
   | `AI_MAX_TOKENS` | optional, defaults to `48000` |
   | `AI_TIMEOUT_MS` | optional, per-attempt budget, defaults to `240000` |
   | `ALLOWED_ORIGINS` | optional, e.g. `https://your-app.vercel.app` |

   `ALLOWED_ORIGINS` restricts which browsers may call the API. Leave it empty to
   allow any origin.

Check it with `/health` once deployed — it reports whether the provider is
configured, without contacting the provider itself, so a provider outage never
makes Render think the instance is unhealthy.

### Frontend on Vercel

1. Go to https://vercel.com/new and **Import** `Nasxx05/inference-manager`.
2. Leave the defaults:
   - Framework Preset: **Next.js**
   - Build Command: `npm run build`
   - Output Directory: `.next` (auto-filled)
   - Install Command: `npm install`
3. Add one environment variable:

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_BACKEND_URL` | your Render URL, e.g. `https://agentfund-backend.onrender.com` |

   No trailing slash. This value is public — it ships in the JavaScript bundle —
   so it must be a URL only, never a credential. It is read at **build** time, so
   redeploy Vercel after changing it.
4. Click **Deploy**. Every push to `main` redeploys automatically; other branches
   get preview URLs.

Notes:
- No database, auth, or external integrations are required to deploy.
- Recent history is `localStorage`, so it is per-browser and not shared between visitors.
- `.env.example` documents the variables; never commit a real `.env` (already gitignored).
- On Render's free tier the instance sleeps when idle, so the first request after
  a pause can take an extra ~30s to wake it.

## The loop

```
What do you want to build?
        ↓
Which questions actually matter here?
        ↓
How complex is it?
        ↓
What can my budget support?
        ↓
Which model fits?
        ↓
How should the task be scoped?
        ↓
What prompt should I use?
        ↓
COPY PROMPT
```

## Architecture

```
server/                 BACKEND - Express on Render. Owns the AI credentials.
  src/index.ts          /health, /api/clarify, /api/plan
  scripts/              Post-build fix so the compiled ESM runs on plain Node
  Compiles the shared lib/ below together with its own entry point.

src/
  app/                  Next.js App Router: static page only, no API routes
  components/           Workspace, TaskForm, ClarifyingQuestions, AnalysisPanel,
                        PromptEditor, HistoryPanel
  data/models.ts        Extensible model metadata (pricing, capabilities, context window)
  lib/
    ai/                 Internal model client: task analysis + prompt writing
    backend.ts          Resolves the backend URL the browser calls
    clarifier/          Task-specific clarifying questions, defaults, answer resolution
    estimator/          Cost estimation and budget feasibility
    models/             Model selection and comparison
    scopeOptimizer/     Scope reduction when a task exceeds budget
    validation/         Structured-output validation and input parsing
    planner.ts          Orchestrates the full pipeline (shared by both sides)
tests/                  Unit tests for every module
```

`src/lib` is deliberately platform-free — no React, no `window` — so the backend can
import the same planning code the frontend ships. Each concern is a separate module,
so pricing, models and the analyzer can be replaced independently.

## Cost estimation

Costs are **calculated**, never invented by the model:

```
input cost        = estimated input tokens  × model input rate
output cost       = estimated output tokens × model output rate
base execution    = input cost + output cost
iteration cost    = extra passes for validation and revision
overhead          = context and tool overhead
estimate range    = (base + iterations + overhead) ± spread
recommended max   = (base + iterations + overhead) × (1 + safety factor)
```

The safety factor and overhead vary by optimization preference and live in one place
(`src/lib/estimator/costEstimator.ts`) so they are easy to tune.

Estimates are always shown as a **range**. They are planning figures, not guaranteed final costs.

## Two separate AI concepts

| | Role |
|---|---|
| **AgentFund's internal AI** | Understands the task and writes the final prompt. Server-side, optional. |
| **User's target AI** | Whatever model the user chose. Runs the prompt later, elsewhere. |

The internal model **writes the prompt**, tailored to the model the user selected. It receives the
task, the planning analysis, every clarifying answer (marked binding when answered, or as an
assumption to restate when skipped), and the target model's capability tier and context window.
It returns the prompt following the section structure it is given (ROLE, OBJECTIVE, CONTEXT,
REQUIREMENTS, ASSUMED DEFAULTS, STRUCTURE AND ARCHITECTURE, SCOPE, OUT OF SCOPE, PRIORITIES,
EXECUTION STRATEGY, CONSTRAINTS, BUDGET CONSTRAINT, VALIDATION, REVISION POLICY, STOPPING
CONDITIONS, OUTPUT FORMAT).

The prompt is **always** model-written — there is no local compiler. A failed attempt is retried
up to three times, and if it still fails the request returns an error rather than a degraded
prompt, so the user is told instead of being handed something weaker than they asked for.
Permanent problems (a bad key, a malformed request) are not retried; transient ones (a rate
limit, a busy provider) are, and each cause gets its own message rather than all collapsing into
"check your configuration".

Configure it on the backend via server-side env vars (see `.env.example`):

```
AI_BASE_URL=...
AI_API_KEY=...
AI_MODEL=...
AI_MAX_TOKENS=48000
AI_TIMEOUT_MS=240000
```

These live on Render, never on Vercel, and are never exposed to the browser.

### Note on reasoning models

The default internal model (`tencent/hy4-preview` via Orbio) reasons before it writes, and the
reasoning shares the same token budget. Given a low `max_tokens`, reasoning consumes everything and
the response contains **no content at all** — only reasoning. Observed: ~37k reasoning tokens
before ~3k of content. `AI_MAX_TOKENS` must stay high, and a request can take 2–3 minutes, which is
why the timeout is generous and the UI shows a "Writing your prompt..." state.

## Explicitly not included

No wallet, seed phrase, API-key input in the browser, CREDIT transfer, agent marketplace, worker
marketplace, autonomous execution, or chatbot UI. CREDIT is a user-provided planning budget, not
a balance.

The Orbio connection is AgentFund's own internal planning and prompt-writing model. It is
server-side only, configured by the operator, and never surfaced to the user — the user never
enters an API key, and the app never touches a wallet or executes a task.

## Notes

- Model pricing is static local configuration for the MVP, clearly not live data. The
  `ModelConfig` shape is provider-agnostic so a live pricing adapter can replace it later.
- Recent prompts are stored in `localStorage` only. No database, no auth.