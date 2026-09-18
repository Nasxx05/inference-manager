/*
 * AgentFund — local server.
 *
 * Serves the static files and exposes two JSON endpoints:
 *   POST /api/analyze  -> structured task analysis
 *   POST /api/prompts  -> three prompt versions
 *
 * API keys stay on the server. If no key is configured the endpoints
 * answer { offline: true } and the browser uses its local estimator.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

// Load .env for local development. In production (Render) the real
// environment variables are already set, so this is a no-op. Values that
// are already present in the environment always win.
(function loadDotEnv() {
  try {
    const file = path.join(__dirname, ".env");
    if (!fs.existsSync(file)) return;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (err) {
    // ignore
  }
})();

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;

/*
 * Estimation model (primary).
 * Any OpenAI-compatible endpoint. Set these three in .env locally, or in
 * the Render dashboard. Never commit real values.
 *
 *   AGENTFUND_BASE_URL  e.g. https://api.example.com/v1
 *   AGENTFUND_API_KEY   your key
 *   AGENTFUND_MODEL     e.g. my-estimation-model
 */
const BASE_URL = (process.env.AGENTFUND_BASE_URL || "").replace(/\/+$/, "");
const API_KEY = process.env.AGENTFUND_API_KEY || "";
const ESTIMATE_MODEL = process.env.AGENTFUND_MODEL || "";

function hasEstimateModel() {
  return Boolean(BASE_URL && API_KEY && ESTIMATE_MODEL);
}

const ANALYZE_MODEL = process.env.AGENTFUND_ANALYZE_MODEL || "";
const PROMPT_MODEL = process.env.AGENTFUND_PROMPT_MODEL || "";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function pickProvider() {
  // The configured estimation model always wins.
  if (hasEstimateModel()) {
    return { name: "estimation", model: ESTIMATE_MODEL };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      name: "anthropic",
      model: ANALYZE_MODEL || PROMPT_MODEL || "claude-sonnet-4-5",
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      name: "openai",
      model: ANALYZE_MODEL || PROMPT_MODEL || "gpt-5",
    };
  }
  if (process.env.GOOGLE_API_KEY) {
    return {
      name: "google",
      model: ANALYZE_MODEL || PROMPT_MODEL || "gemini-2.5-pro",
    };
  }
  return null;
}

function hasKey() {
  return pickProvider() !== null;
}

function activeProviderName() {
  const p = pickProvider();
  return p ? p.name : "none";
}

/** Pull the first balanced JSON object out of a model reply. */
function extractJson(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch (err) {
          return null;
        }
      }
    }
  }
  return null;
}

/*
 * Extract usable text from a chat completion message.
 *
 * Reasoning models (like tencent/hy4-preview) often return content:null
 * and put the answer in `reasoning` when the token budget is too small,
 * or return content as an array of parts. Handle all of these, preferring
 * real content over reasoning text.
 */
function messageContent(message, data) {
  const direct = message && message.content;
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  if (Array.isArray(direct)) {
    const joined = direct
      .map((p) => (typeof p === "string" ? p : p && (p.text || p.content) ? p.text || p.content : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (joined) return joined;
  }

  const alternatives = [
    data && data.output_text,
    message && message.reasoning,
    message && message.reasoning_content,
  ];
  for (const alt of alternatives) {
    if (typeof alt === "string" && alt.trim()) return alt.trim();
  }
  return "";
}

/*
 * Repair an analysis returned by a model.
 *
 * Real models sometimes return a modelId that is not in our catalog
 * (e.g. "auto"), or skip modelComparison entirely. Both would leave the
 * UI with an unresolvable model or an empty comparison list, so we
 * substitute a sensible model and build the comparison ourselves.
 */
function normalizeAnalysis(analysis) {
  if (!analysis || typeof analysis !== "object") return analysis;

  const classification = analysis.classification || {};
  const passes = (analysis.executionProfile && analysis.executionProfile.passes) || 3;

  const rec = analysis.modelRecommendation || {};
  let model = getModelById(rec.modelId);
  if (!model) {
    model = chooseFallbackModel(classification, passes);
    analysis.modelRecommendation = {
      modelId: model.id,
      reason: rec.reason || "Selected from the catalog for this task profile.",
    };
  }

  const valid = (analysis.modelComparison || []).filter(
    (row) => row && getModelById(row.modelId)
  );
  if (valid.length < 2) {
    analysis.modelComparison = buildFallbackComparison(model, classification, passes);
  } else {
    analysis.modelComparison = valid.slice(0, 3);
  }

  return analysis;
}

/*
 * The model catalog and cost maths live in the browser modules. Load them
 * once at startup so the server and the UI can never disagree about
 * prices or model ids.
 */
let CATALOG = [];
let COST_HELPERS = null;

async function loadCatalog() {
  if (CATALOG.length) return;
  try {
    const models = await import("./js/models.mjs");
    CATALOG = models.availableModels();
    COST_HELPERS = models;
  } catch (err) {
    CATALOG = [];
    COST_HELPERS = null;
  }
}

function getModelById(id) {
  return CATALOG.find((m) => m.id === id) || null;
}

function priceOf(model) {
  return (model.inputPrice + model.outputPrice) / 2;
}

/** Cheapest model that can still handle this task profile. */
function chooseFallbackModel(classification, passes) {
  const pool = CATALOG.length ? CATALOG.slice() : [];
  if (!pool.length) return null;
  const needHigh =
    classification.complexity === "High" || classification.complexity === "Very High";
  const acceptable = pool.filter((m) => (needHigh ? m.capability === "High" : true));
  const list = acceptable.length ? acceptable : pool;
  return list.slice().sort((a, b) => priceOf(a) - priceOf(b))[0];
}

function costForModel(model, classification, passes) {
  if (!model) return { low: 1, high: 2 };
  if (COST_HELPERS && COST_HELPERS.estimatePassTokens) {
    const { inputTokens, outputTokens } = COST_HELPERS.estimatePassTokens(classification);
    const perPass = COST_HELPERS.passCostCredits(model, inputTokens, outputTokens);
    const total = perPass * (passes || 3);
    return {
      low: Math.max(1, Math.round(total * 0.8)),
      high: Math.max(2, Math.round(total * 1.25)),
    };
  }
  return { low: 1, high: 2 };
}

/** Build 2-3 comparison rows around the recommended model. */
function buildFallbackComparison(recommended, classification, passes) {
  const pool = CATALOG.slice().filter((m) => m.available !== false);
  if (!pool.length) return [];

  const cheapest = pool.slice().sort((a, b) => priceOf(a) - priceOf(b))[0];
  const strongest = pool.slice().sort((a, b) => priceOf(b) - priceOf(a))[0];

  const chosen = [];
  const push = (m) => {
    if (m && !chosen.some((c) => c.id === m.id)) chosen.push(m);
  };

  push(recommended);
  push(cheapest);
  push(strongest);
  pool
    .slice()
    .sort((a, b) => priceOf(a) - priceOf(b))
    .forEach((m) => {
      if (chosen.length < 2) push(m);
    });

  return chosen.slice(0, 3).map((m) => {
    const cost = costForModel(m, classification, passes);
    return {
      modelId: m.id,
      low: cost.low,
      high: cost.high,
      capability: m.capability,
      note:
        m.id === (recommended && recommended.id)
          ? "Recommended for this task at this price."
          : m.id === cheapest.id
          ? "Cheapest option."
          : "Highest capability option.",
    };
  });
}

async function callModel(model, system, user, maxTokens = 3000) {
  const provider = pickProvider();
  if (!provider) throw new Error("no_provider");

  if (provider.name === "estimation") {
    const payload = {
      model: ESTIMATE_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    };
    // Many OpenAI-compatible servers accept max_tokens; a few only accept
    // max_completion_tokens. Send both and drop whichever is rejected.
    const attempts = [
      Object.assign({}, payload, { max_tokens: maxTokens }),
      Object.assign({}, payload, { max_completion_tokens: maxTokens }),
      payload,
    ];

    let lastStatus = 0;
    for (let i = 0; i < attempts.length; i += 1) {
      const res = await fetch(BASE_URL + "/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + API_KEY,
        },
        body: JSON.stringify(attempts[i]),
      });
      if (res.ok) {
        const data = await res.json();
        const message = (data.choices && data.choices[0] && data.choices[0].message) || {};
        const text = messageContent(message, data);
        if (text) return text;
        lastStatus = res.status;
        continue;
      }
      lastStatus = res.status;
    }
    throw new Error("estimation_" + lastStatus);
  }

  if (provider.name === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model || provider.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic_${res.status}`);
    const data = await res.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return text;
  }

  if (provider.name === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: model || provider.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`openai_${res.status}`);
    const data = await res.json();
    return (data.choices && data.choices[0] && data.choices[0].message.content) || "";
  }

  // google
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${
    model || provider.model
  }:generateContent?key=${process.env.GOOGLE_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
    }),
  });
  if (!res.ok) throw new Error(`google_${res.status}`);
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("\n");
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  const target = path.normalize(path.join(ROOT, rel));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(target, (err, buf) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(target)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, online: hasKey(), provider: activeProviderName() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/analyze") {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, 400, { error: "bad_request" });
      return;
    }
    if (!hasKey()) {
      sendJson(res, 200, { offline: true });
      return;
    }
    try {
      await loadCatalog();
      const schema = await import("./js/analysis-schema.mjs");
      const text = await callModel(
        ANALYZE_MODEL,
        schema.ANALYSIS_SYSTEM,
        schema.analysisUserPrompt(body),
        Number(process.env.AGENTFUND_ANALYZE_MAX_TOKENS || 12000)
      );
      const analysis = normalizeAnalysis(extractJson(text));
      if (!analysis) throw new Error("unparseable");
      sendJson(res, 200, { analysis });
    } catch (err) {
      sendJson(res, 200, { error: "analysis_failed" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/prompts") {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, 400, { error: "bad_request" });
      return;
    }
    if (!hasKey()) {
      sendJson(res, 200, { offline: true });
      return;
    }
    try {
      const schema = await import("./js/analysis-schema.mjs");
      const text = await callModel(
        PROMPT_MODEL,
        schema.PROMPT_SYSTEM,
        schema.promptUserPrompt(body),
        Number(process.env.AGENTFUND_PROMPT_MAX_TOKENS || 16000)
      );
      const prompts = extractJson(text);
      if (!prompts) throw new Error("unparseable");
      sendJson(res, 200, { prompts });
    } catch (err) {
      sendJson(res, 200, { error: "prompt_failed" });
    }
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res, url.pathname);
    return;
  }

  sendJson(res, 405, { error: "method_not_allowed" });
});

server.listen(PORT, () => {
  const provider = activeProviderName();
  let mode;
  if (provider === "estimation") mode = "estimation model: " + ESTIMATE_MODEL;
  else if (provider === "none") mode = "offline estimator (no model configured)";
  else mode = "AI analysis via " + provider;
  console.log("AgentFund running: http://localhost:" + PORT + "  [" + mode + "]");
});
