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

```bash
npm install
npm run dev
```

Open http://localhost:3000.

```bash
npm test     # 103 tests
npm run build
```

## Deploying to Vercel

Vercel detects Next.js automatically, so no configuration file is needed.

1. Push this repo to GitHub (already done).
2. Go to https://vercel.com/new and **Import** `Nasxx05/inference-manager`.
3. Leave the defaults:
   - Framework Preset: **Next.js**
   - Build Command: `npm run build`
   - Output Directory: `.next` (auto-filled)
   - Install Command: `npm install`
4. (Optional) Add env vars under **Settings → Environment Variables**:

   | Name | Value |
   |---|---|
   | `AI_API_KEY` | key for AgentFund's internal planner |
   | `AI_BASE_URL` | provider base URL, e.g. `https://api.openai.com/v1` |
   | `AI_MODEL` | planner model id, e.g. `gpt-4o-mini` |

   These are optional — with none set, AgentFund uses its deterministic local analyzer and
   still returns a complete plan. They are server-only and never sent to the browser.
5. Click **Deploy**. Every push to `main` redeploys automatically; other branches get preview URLs.

Notes:
- No database, auth, or external integrations are required to deploy.
- Recent history is `localStorage`, so it is per-browser and not shared between visitors.
- `.env.example` documents the variables; never commit a real `.env` (already gitignored).

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
src/
  app/                  Next.js App Router: page + /api/analyze + /api/clarify
  components/           Workspace, TaskForm, ClarifyingQuestions, AnalysisPanel,
                        PromptEditor, HistoryPanel
  data/models.ts        Extensible model metadata (pricing, capabilities, context window)
  lib/
    ai/                 Internal model: task analysis + prompt writing (the prompt source)
    clarifier/          Task-specific clarifying questions, defaults, answer resolution
    estimator/          Cost estimation and budget feasibility
    models/             Model selection and comparison
    scopeOptimizer/     Scope reduction when a task exceeds budget
    validation/         Structured-output validation and input parsing
    planner.ts          Orchestrates the full pipeline
tests/                  Unit tests for every module
```

Each concern is a separate module so pricing, models and the analyzer can be replaced independently.

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
once, and if it still fails the request returns an error rather than a degraded prompt, so the
user is told instead of being handed something weaker than they asked for.

Configure it via server-side env vars (see `.env.example`):

```
AI_API_KEY=...
AI_BASE_URL=...
AI_MODEL=...
AI_MAX_TOKENS=16000
AI_TIMEOUT_MS=240000
```

These are never exposed to the browser, and `.env.local` is gitignored.

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