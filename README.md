# AgentFund

Describe a task, pick a budget, and find out what it will cost before you run it —
then copy a ready-made prompt into the model of your choice.

AgentFund plans and writes prompts. It never executes your task.

## Run locally

```bash
npm install     # no dependencies; safe to skip
npm start       # http://localhost:4173
```

## Connect your estimation model

The app works out of the box with a built-in local estimator. To use your own
OpenAI-compatible model instead, set three values.

**Locally** — copy the example file and fill it in:

```bash
cp .env.example .env
```

```
AGENTFUND_BASE_URL=https://your-provider.example.com/v1
AGENTFUND_API_KEY=your-key-here
AGENTFUND_MODEL=your-model-name
```

`.env` is gitignored, so your key stays off GitHub.

**On Render** — set the same three variables in your service's *Environment* tab.
Do not upload your `.env` file.

When configured, the header badge shows "AI analysis enabled"; otherwise it shows
"Local estimator". `/api/health` reports which one is active:

```bash
curl https://your-service.onrender.com/api/health
# {"ok":true,"online":true,"provider":"estimation"}
```

If the model is unreachable or returns something unparseable, the app falls back
to the local estimator automatically rather than failing.

## Deploy to Render

1. Push this project to a GitHub repo.
2. In Render: **New → Blueprint**, select the repo. Render reads `render.yaml`.
3. When prompted, enter `AGENTFUND_BASE_URL`, `AGENTFUND_API_KEY`, `AGENTFUND_MODEL`.
   (Render asks for these because `render.yaml` marks them `sync: false`.)
4. Deploy. The health check hits `/api/health`.

No build step and no dependencies — the service just runs `node server.js`.

## How it works

One model is called sequentially: first to analyze the task (returning structured
JSON: classification, cost range, feasibility, model recommendation), then to write
three prompt versions from that analysis.

- Costs are always shown as a **range**, never a single number.
- Recommended maximum = high estimate × 1.2; reserve = 25% of that.
- Three feasibility states: fits, fits with cuts, doesn't fit.
- Model advice never claims a universal "best" — it shows 2–3 candidates with cost,
  capability, and a one-line reason.

## Data and privacy

Tasks and prompts are saved in your browser's `localStorage` (tables `af_users`,
`af_tasks`, `af_prompts`, `af_models`). There are no accounts and no server-side
database. The task text leaves your browser only when you request an analysis or a
prompt.

## Layout

```
index.html          all four phases
styles.css
server.js           static server + /api/analyze, /api/prompts, /api/health
js/models.mjs       model catalog (the single place prices live)
js/analysis-schema.mjs  the JSON contract for the model (server-side, ESM)
js/ai.js            model calls + offline estimator fallback
js/storage.js       localStorage shaped like database tables
js/dom.js           rendering helpers
js/app.js           phase wiring