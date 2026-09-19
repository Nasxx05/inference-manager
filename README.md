# AgentFund

A budget-aware AI task planner and prompt compiler.

Describe what you want to accomplish, choose a target model, a quality preference and a CREDIT
budget. AgentFund analyzes the task, estimates the inference cost, checks it against your budget,
optimizes scope when needed, and produces an execution-ready prompt you can copy and run yourself.

**AgentFund never executes your task.** The prompt is the product.

## How it works

1. **Describe the task.** AgentFund classifies it locally and returns 3–6
   questions specific to *your* task — not a fixed generic list. A portfolio site
   is asked about audience, design direction, stack and pages; a tic-tac-toe game
   is asked about single vs two player, visual style, win/draw handling and extras.
2. **Answer or skip.** Any combination, or type your own. Every question has a
   sensible default, so skipping still yields a usable prompt.
3. **Review the plan.** One model call produces the analysis and the prompt;
   cost, feasibility, scope and model recommendation are then calculated locally.
4. **Copy the prompt.** The internal model writes it from your answers, shaped for the model you
   selected.

Pick as many options as apply on any question — they are combined into that answer, and you can
type your own alongside them. Questions where only one answer makes sense (language, tone,
duration) are exclusive: choosing one replaces the other.

Skipping is always allowed. Every question carries a sensible default, so if you skip you still
get a usable prompt — just less detailed. Skipped questions appear in the prompt under
**ASSUMED DEFAULTS** so the executor can restate them and you can correct them.

The clarifying step is local and instant — it only affects the prompt. Cost
estimation, feasibility and model recommendation are unchanged whether you
answer or skip.

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

Locally the backend reads the `AGENTFUND_AI_*` values from the root `.env.local`
on startup (a plain Node process does not do this by itself). Values already
present in the real environment are never overwritten, so the same code is
driven by the Render dashboard in production and by `.env.local` on your
machine. The startup log prints `Env files loaded: ...` (or `none`), the model
in use, and the budgets.

```bash
npm test           # 141 tests
npm run build
```

## The one-call flow

A completed task normally makes **one** LLM call. Everything else is local.

```text
User task
  ↓   POST /api/clarify    local classifier only — NO LLM call
Clarifying questions
  ↓   user answers or skips
  ↓   POST /api/plan       ONE call: { taskAnalysis, generatedPrompt }
  ↓   local cost estimate, feasibility, scope, model recommendation
Final result → browser
```

The combined call asks for the task analysis and the finished prompt together,
which removes one entire provider round trip. The model is explicitly told not
to compute money: cost, recommended maximum, reserve, feasibility and scope
reduction stay local, derived from model metadata plus the token estimates, so
the numbers remain deterministic and reproducible.

Classification for the clarifying step is deterministic (`heuristicAnalyze`): it
only needs a task type good enough to pick a relevant question set. So
`/api/clarify` returns immediately and keeps working even when the provider is
down or unconfigured, while `/api/plan` reports a structured error in that case.

### Two-call fallback

If a model cannot reliably return both halves together, the pipeline falls back
to analyze-then-write automatically, so it still works instead of failing. The
fallback costs one extra round trip, but only for models that need it. It
engages when a combined response fails validation, or when forced with
`AGENTFUND_AI_COMBINED=0`.

### What the generation screen shows

While a request runs, the UI shows an animated AgentFund mark, a short project
title derived locally from the task, and rotating stage labels ("Analyzing your
request...", "Estimating the work...", "Optimizing the prompt...").

There is **no percentage**, because the backend does not report one, and no
artificial delay — the animation runs for exactly as long as the real request is
in flight. Analyze is disabled during a request and Cancel aborts it, so
duplicate submissions cannot start two expensive calls.

## How it is deployed

AgentFund ships as two services. The split exists because writing a prompt takes
a few minutes, and a serverless function would time out long before it finished.

| | Frontend | Backend |
|---|---|---|
| Platform | Vercel | Render |
| Code | repo root | `server/` |
| Type | Next.js, fully static | Express web service |
| Holds | no credentials | `AGENTFUND_AI_API_KEY`, `AGENTFUND_AI_BASE_URL`, `AGENTFUND_AI_MODEL` |
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
   | `AGENTFUND_AI_BASE_URL` | provider API base, e.g. `https://api.example.com/v1` |
   | `AGENTFUND_AI_API_KEY` | key for AgentFund's internal model |
   | `AGENTFUND_AI_MODEL` | model id, e.g. `z-ai/glm-5.3-flash` |
   | `AGENTFUND_AI_MAX_TOKENS` | optional, defaults to `4500` (the combined call) |
   | `AGENTFUND_AI_ANALYSIS_MAX_TOKENS` | optional, defaults to `1800` (fallback only) |
   | `AGENTFUND_AI_PROMPT_MAX_TOKENS` | optional, defaults to `3000` (fallback only) |
   | `AGENTFUND_AI_COMBINED` | optional, set `0` to force the two-call path |
   | `AGENTFUND_AI_TIMEOUT_MS` | optional, per-attempt budget, defaults to `90000` |
   | `AGENTFUND_AI_FALLBACK_MODEL` | optional, used only if the primary is unavailable |
   | `ALLOWED_ORIGINS` | optional, e.g. `https://your-app.vercel.app` |

   `ALLOWED_ORIGINS` restricts which browsers may call the API. Leave it empty
   to allow any origin — fine locally, but set it in production.

   The base URL is the API **base**, not the endpoint. The backend appends
   `/chat/completions` itself, exactly once; do not include it here.

   The old `AI_*` names still work if the `AGENTFUND_AI_*` ones are unset, but
   a stale `AI_MODEL` never overrides `AGENTFUND_AI_MODEL`. Rename when you can:
   the startup log warns while legacy names are in use.

### Token budgets

There is no shared 48000-token limit.

| Path | Variable | Default | Why |
|---|---|---|---|
| Combined (normal) | `AGENTFUND_AI_MAX_TOKENS` | `4500` | Covers a compact JSON analysis plus a detailed prompt, without room to pad. |
| Fallback: analysis | `AGENTFUND_AI_ANALYSIS_MAX_TOKENS` | `1800` | Returns one compact JSON object. More would only buy reasoning. |
| Fallback: prompt | `AGENTFUND_AI_PROMPT_MAX_TOKENS` | `3000` | The prompt is the deliverable, roughly 500-900 words. |
| Any call | `AGENTFUND_AI_TIMEOUT_MS` | `90000` | Per-attempt deadline, enforced with `AbortController`. |

The deprecated unprefixed `AI_MAX_TOKENS` (historically `48000`) is **ignored**:
honouring it would restore one huge cap for every call. The backend warns at
startup while it is present. Delete it. `AGENTFUND_AI_MAX_TOKENS` is a different
variable and is read normally.

The health echo test uses a fixed 32-token cap, so a health check never costs
what a real request costs.

### The internal model is configurable

`AGENTFUND_AI_MODEL` powers AgentFund itself: task analysis, cost planning,
scope optimization and prompt compilation. It is completely separate from the
**target model** the user picks in the UI — AgentFund can internally use one
vendor's model while writing a prompt optimized for another.

No model is hard-coded. Changing `AGENTFUND_AI_MODEL` alone switches the
internal model; any model compatible with the configured OpenAI-style provider
works. Where a model needs an optional parameter, it is supplied by
`getCompatibleRequestOptions()` and nowhere else, so the rest of the system
stays model-independent.

### Checking the deployment

Two separate probes, so a provider outage is never mistaken for a dead backend:

```bash
curl https://your-service.onrender.com/health      # the backend itself
curl https://your-service.onrender.com/health/ai   # the provider connection
curl https://your-service.onrender.com/health/ai/test  # trivial echo test
```

`/health` never contacts the provider, so Render will not kill a healthy
instance during a provider outage. It reports `providerConfigured`,
`apiKeyPresent` (presence only, never the value), `modelConfigured`, `model`,
and a `missing` list naming exactly which variables are absent.

`/health/ai` checks the connection end to end and returns:

```json
{
  "status": "ok",
  "providerConfigured": true,
  "providerReachable": true,
  "modelConfigured": true,
  "modelAvailable": true,
  "model": "configured-model-id"
}
```

It verifies the configured model against the provider's model list rather than
assuming it is valid, then sends a trivial request expecting the exact string
`AGENTFUND_TEST_OK`. That echo test separates provider problems from
prompt-generation problems: if it passes but `/api/plan` fails, the fault is in
prompt generation, not the connection. It never uses the full AgentFund prompt.

`/health` also reports the caps in force under `budgets`, so a deployment can be
confirmed without reading the dashboard.

Troubleshooting order: key present → base URL present → model present → model
exists → provider reachable → test request succeeds. `modelAvailable:false`
means the configured id is not in the provider's list. `providerConfigured:
false` with a non-empty `missing` list means the variables never reached the
process: check for a typo, an empty value, or a trailing newline, and redeploy
after saving.

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
- In production the frontend fails clearly if `NEXT_PUBLIC_BACKEND_URL` is
  missing rather than silently calling localhost.
- On Render's free tier the instance sleeps when idle, so the first request after
  a pause can take an extra ~30s to wake it.

### Verifying a deployment end to end

Test in this order, so a failure points at the right layer:

1. `GET /health` — backend is up and configured.
2. `GET /health/ai` — model exists and the provider answers.
3. `GET /health/ai/test` — the trivial echo returns `AGENTFUND_TEST_OK`.
4. `POST /api/clarify` — local classification, returns immediately.
5. `POST /api/plan` — one combined call, or two on the fallback path.
6. The Vercel frontend.

A completed task should show `clarify` at ~0ms and `calls=1` in `/api/plan`. If
it reports two, check whether the fallback engaged and why.

### Render cold starts

Render's free web services spin down when idle and can take up to a minute to
wake. Backend startup is kept light for that reason: no database, no heavy
imports, and configuration is read per call rather than precomputed. If the first
request after idle is much slower than later ones, that delay is platform cold
start rather than prompt generation — visible in the logs because
`llmDurationMs` stays normal while `totalDurationMs` is large.

To confirm the backend really is model-agnostic, set `AGENTFUND_AI_MODEL` to a
different valid id and repeat steps 2, 3 and 5. No code change is involved: if
the same build works, nothing is pinned to one vendor.

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
  src/index.ts          /health, /health/ai, /health/ai/test, /api/clarify, /api/plan
                        clarify = local only; plan = 1 LLM call, timed per stage
  scripts/              Post-build fix so the compiled ESM runs on plain Node
  Compiles the shared lib/ below together with its own entry point.

src/
  app/                  Next.js App Router: static page only, no API routes
  components/           Workspace, TaskForm, ClarifyingQuestions, AnalysisPanel,
                        PromptEditor, HistoryPanel, GeneratingScreen
  data/models.ts        Extensible model metadata (pricing, capabilities, context window)
  lib/
    ai/                 Internal model client: analysis + prompt writing
      env.ts            AGENTFUND_AI_* config, per-path caps, read per call
      errors.ts         Error codes, request ids, retry classification
      chatClient.ts     Generic OpenAI-compatible adapter (the only HTTP caller)
      combined.ts       ONE call returning analysis + prompt (normal path)
      prompt.ts         Shared prompt normalization and validation
      json.ts           Shared JSON extraction from model output
      health.ts         Provider diagnostics and the AGENTFUND_TEST_OK echo test
      provider.ts       Task analysis (two-call fallback), validated
      promptGenerator.ts Prompt writing (two-call fallback), validated
      taskAnalyzer.ts   Local classifier for /api/clarify + field normalizer
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

The prompt is **always** model-written — there is no local compiler, and no
heuristic substitute. If the model fails or returns something unusable, the
request fails loudly with a structured error; the user is never handed a degraded
prompt that looks like success.

Retries are strictly bounded and never stack. Transport and transient failures
(a rate limit, a timeout, a 502/503, a network fault) get at most one retry,
inside the adapter. Malformed structured output gets at most one further
attempt. A bad key, an unknown model or a malformed request is never retried,
because it can only delay the same answer. Every request is bounded by
`AGENTFUND_AI_TIMEOUT_MS`, so a slow provider cannot hold a call open.

Configure it on the backend via server-side env vars (see `.env.example`):

```
AGENTFUND_AI_BASE_URL=...
AGENTFUND_AI_API_KEY=...
AGENTFUND_AI_MODEL=...
AGENTFUND_AI_MAX_TOKENS=4500
AGENTFUND_AI_TIMEOUT_MS=90000
```

These live on Render, never on Vercel, and are never exposed to the browser.

### Error contract and observability

Every failure uses one shape, and raw provider text is never forwarded:

```json
{ "success": false, "error": { "code": "AI_TIMEOUT", "message": "...", "requestId": "req_abc123" } }
```

Codes: `BACKEND_NOT_CONFIGURED`, `AI_PROVIDER_UNREACHABLE`, `AI_AUTH_FAILED`,
`AI_MODEL_UNAVAILABLE`, `AI_RATE_LIMITED`, `AI_TIMEOUT`, `AI_INVALID_RESPONSE`,
`AI_VALIDATION_FAILED`, `AI_UNKNOWN_ERROR`.

Every AI call is assigned a `requestId`, returned in errors and logged in one
structured line: timestamp, requestId, **stage**, endpoint, model, duration,
success, HTTP status and error code. Nothing sensitive is logged — no key, no
Authorization header, no prompt body.

Each request also logs one line per stage, which is what makes a slow request
diagnosable:

```text
[timing] requestId=req_dc6bd1ac5d stage=combined-analysis-and-prompt model=z-ai/glm-5.3-flash
  totalDurationMs=5 llmDurationMs=4 providerDurationMs=- parseDurationMs=0
  localDurationMs=0 success=true retryCount=0 errorCode=-
[stage] requestId=req_28e33a9204 stage=combined-analysis-and-prompt durationMs=4 success=true calls=1
[stage] requestId=req_28e33a9204 stage=total durationMs=5 success=true calls=1 local=0ms parse=0ms
```

`clarify` is logged too and should be ~0ms, since it is local, and `calls=1` is
the LLM request count for that plan. LLM time, parse time and local time are
separated, so a slow request is attributable to the provider or to AgentFund
without guessing. The same figures come back on the plan as `llmDurationMs`,
`localDurationMs`, `parseDurationMs`, `totalDurationMs`, `llmCalls` and
`retryCount`.

### Note on reasoning models

Some models reason before they write, and reasoning shares the same output cap:
given too low a cap, reasoning can consume everything and the response comes
back with **no content at all**. Reasoning models are therefore given a low
`reasoning_effort` through `getCompatibleRequestOptions()` — the only place any
model-specific parameter is set — which keeps them inside the same modest caps
as every other model. If a model still runs out of room, the response is treated
as unusable and retried once rather than truncated into a broken prompt. Raise
`AGENTFUND_AI_MAX_TOKENS` (or the fallback caps) only if a specific model
genuinely needs it.

## Explicitly not included

No wallet, seed phrase, API-key input in the browser, CREDIT transfer, agent marketplace, worker
marketplace, autonomous execution, or chatbot UI. CREDIT is a user-provided planning budget, not
a balance.

The internal planning and prompt-writing model is server-side only, configured by
the operator through `AGENTFUND_AI_*`, and never surfaced to the user — the user
never enters an API key, and the app never touches a wallet or executes a task.

## Notes

- Model pricing is static local configuration for the MVP, clearly not live data. The
  `ModelConfig` shape is provider-agnostic so a live pricing adapter can replace it later.
- Recent prompts are stored in `localStorage` only. No database, no auth.