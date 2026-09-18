# AgentFund

A budget-aware AI task planner and prompt compiler.

Describe what you want to accomplish, choose a target model, a quality preference and a CREDIT
budget. AgentFund analyzes the task, estimates the inference cost, checks it against your budget,
optimizes scope when needed, and produces an execution-ready prompt you can copy and run yourself.

**AgentFund never executes your task.** The prompt is the product.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:3000.

```bash
npm test     # 63 tests
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
  app/                  Next.js App Router: page + /api/analyze
  components/           Workspace, TaskForm, AnalysisPanel, PromptEditor, HistoryPanel
  data/models.ts        Extensible model metadata (pricing, capabilities, context window)
  lib/
    ai/                 Internal planning model client + deterministic fallback analyzer
    estimator/          Cost estimation and budget feasibility
    models/             Model selection and comparison
    promptCompiler/     Structured, model-aware prompt generation
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
| **AgentFund's internal AI** | Understands the task, estimates scope, compiles the prompt. Server-side, optional. |
| **User's target AI** | Whatever model the user chose. Runs the prompt later, elsewhere. |

If no internal provider is configured, AgentFund falls back to a deterministic local analyzer and
still produces a complete plan. Configure it via server-side env vars (see `.env.example`):

```
AI_API_KEY=...
AI_BASE_URL=...
AI_MODEL=...
```

These are never exposed to the browser.

## Explicitly not included

No Orbio connection, wallet, seed phrase, API-key input, CREDIT transfer, agent marketplace,
worker marketplace, autonomous execution, or chatbot UI. CREDIT is a user-provided planning
budget, not a balance.

## Notes

- Model pricing is static local configuration for the MVP, clearly not live data. The
  `ModelConfig` shape is provider-agnostic so a live pricing adapter can replace it later.
- Recent prompts are stored in `localStorage` only. No database, no auth.