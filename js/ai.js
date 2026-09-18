/*
 * AgentFund — AI layer.
 *
 * One model, called sequentially: analyze, then write prompts.
 * If the server has no key (or is not running) we fall back to a local
 * deterministic estimator so every phase still works end to end.
 */

import {
  MODELS,
  AUTO_SELECT,
  getModel,
  availableModels,
  estimatePassTokens,
  passCostCredits,
} from "./models.mjs";

const PHASES = [
  "Requirements",
  "Planning",
  "Implementation",
  "Testing",
  "Review",
];

const PHASE_WEIGHTS = [0.09, 0.06, 0.52, 0.2, 0.13];

const PASSES = { Low: 2, Medium: 3, High: 4, "Very High": 5 };

const OPT_FACTOR = {
  "Minimize Cost": 0.75,
  Balanced: 1.0,
  "Prioritize Quality": 1.3,
};

/* ------------------------------------------------------------------ */
/* network                                                              */
/* ------------------------------------------------------------------ */

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.json();
}

export async function healthCheck() {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    if (!res.ok) return { ok: false, online: false };
    return await res.json();
  } catch (err) {
    return { ok: false, online: false };
  }
}

export async function analyzeTask({ goal, requestedModel, budget, optimization }) {
  try {
    const data = await postJson("/api/analyze", {
      goal,
      requestedModel,
      budget,
      optimization,
      catalog: catalogForPrompt(),
    });
    if (data && data.analysis) return data.analysis;
    if (data && data.offline) return offlineAnalyze({ goal, requestedModel, budget, optimization });
    throw new Error("analysis_failed");
  } catch (err) {
    return offlineAnalyze({ goal, requestedModel, budget, optimization });
  }
}

export async function writePrompts(context) {
  try {
    const data = await postJson("/api/prompts", context);
    if (data && data.prompts) return data.prompts;
    if (data && data.offline) return offlinePrompts(context);
    throw new Error("prompt_failed");
  } catch (err) {
    return offlinePrompts(context);
  }
}

function catalogForPrompt() {
  return availableModels()
    .map(
      (m) =>
        `- ${m.id} | ${m.provider} ${m.name} | capability ${m.capability} | ` +
        `in $${m.inputPrice}/M out $${m.outputPrice}/M | ctx ${m.contextWindow} | ` +
        `good at: ${m.strengths.join("; ")}`
    )
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* offline fallback                                                     */
/* ------------------------------------------------------------------ */

const RULES = [
  {
    type: "Code debugging",
    complexity: "Medium",
    size: "Small",
    words: ["bug", "error", "fix", "crash", "broken", "debug", "stack trace", "fails"],
  },
  {
    type: "Code review",
    complexity: "Medium",
    size: "Medium",
    words: ["review", "audit", "refactor suggestions", "code quality", "security review"],
  },
  {
    type: "Automation or scripting",
    complexity: "Medium",
    size: "Medium",
    words: ["script", "automate", "cron", "pipeline", "scrape", "scraper", "batch"],
  },
  {
    type: "Data analysis",
    complexity: "High",
    size: "Medium",
    words: ["data", "csv", "dataset", "analysis", "chart", "metrics", "sql", "report"],
  },
  {
    type: "Research or summarization",
    complexity: "Medium",
    size: "Medium",
    words: ["research", "summarize", "summary", "compare", "market", "competitor", "literature"],
  },
  {
    type: "Writing or editing",
    complexity: "Medium",
    size: "Medium",
    words: ["write", "draft", "edit", "rewrite", "blog", "email", "copy", "article", "essay"],
  },
  {
    type: "Design or planning",
    complexity: "High",
    size: "Large",
    words: ["design", "architecture", "plan", "roadmap", "spec", "system design", "schema"],
  },
  {
    type: "Code generation",
    complexity: "High",
    size: "Large",
    words: [
      "build",
      "create",
      "app",
      "website",
      "api",
      "feature",
      "implement",
      "cli",
      "dashboard",
      "frontend",
      "backend",
      "game",
    ],
  },
];

const SCALE_WORDS = [
  "production",
  "enterprise",
  "scalable",
  "distributed",
  "microservice",
  "multi-tenant",
  "full stack",
  "end to end",
  "complete",
  "large",
  "entire",
];

function classify(goal) {
  const lower = goal.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const rule of RULES) {
    const score = rule.words.reduce((n, w) => (lower.includes(w) ? n + 1 : n), 0);
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }
  const type = best ? best.type : "Other";
  let complexity = best ? best.complexity : "Medium";
  let size = best ? best.size : "Medium";

  const scaleHits = SCALE_WORDS.reduce((n, w) => (lower.includes(w) ? n + 1 : n), 0);
  if (scaleHits >= 2) {
    complexity = bump(complexity, 1);
    size = size === "Small" ? "Medium" : "Large";
  } else if (scaleHits === 1) {
    complexity = bump(complexity, 1);
  }

  const contextRequirement = size === "Large" || complexity === "Very High" ? "High" : size === "Small" ? "Low" : "Medium";
  const externalToolsLikely = /api|internet|search|browse|fetch|scrape|database|deploy/i.test(lower);

  return { taskType: type, complexity, outputSize: size, contextRequirement, externalToolsLikely };
}

function bump(level, steps) {
  const order = ["Low", "Medium", "High", "Very High"];
  const i = order.indexOf(level);
  return order[Math.min(order.length - 1, Math.max(0, i + steps))];
}

function isVague(goal, requestedModel) {
  const words = goal.trim().split(/\s+/).filter(Boolean);
  return words.length < 4;
}

function pickTargetModel(classification, requestedModel, optimization) {
  const pool = availableModels();
  if (requestedModel && requestedModel !== AUTO_SELECT) {
    const explicit = getModel(requestedModel);
    if (explicit) return explicit;
  }

  const needHigh = classification.complexity === "High" || classification.complexity === "Very High";
  const needContext = classification.contextRequirement === "High";
  const acceptable = pool.filter((m) =>
    needHigh || needContext ? m.capability === "High" : true
  );
  const list = acceptable.length ? acceptable : pool;

  const sorted = list.slice().sort((a, b) => {
    if (optimization === "Prioritize Quality") {
      const rank = { High: 3, Medium: 2, Low: 1 };
      return rank[b.capability] - rank[a.capability] || priceOf(a) - priceOf(b);
    }
    if (optimization === "Minimize Cost") {
      return priceOf(a) - priceOf(b);
    }
    // Balanced: cheapest High-capability model.
    const rank = { High: 3, Medium: 2, Low: 1 };
    return rank[b.capability] - rank[a.capability] || priceOf(a) - priceOf(b);
  });

  return sorted[0];
}

function priceOf(model) {
  return (model.inputPrice + model.outputPrice) / 2;
}

function costForModel(model, classification, passes) {
  const { inputTokens, outputTokens } = estimatePassTokens(classification);
  const perPass = passCostCredits(model, inputTokens, outputTokens);
  const total = perPass * passes;
  return { low: round(total * 0.8), high: round(total * 1.25) };
}

function round(n) {
  return Math.max(1, Math.round(n));
}

function buildComparison(target, classification, passes) {
  const pool = availableModels();

  // Candidates in priority order: the recommendation, then the cheapest
  // model, then the most capable one. Duplicates are dropped, then the
  // list is topped up from the catalog so 2-3 distinct rows always show.
  const cheapest = pool.slice().sort((a, b) => priceOf(a) - priceOf(b))[0];
  const strongest = pool
    .slice()
    .sort((a, b) => priceOf(b) - priceOf(a))[0];

  const chosen = [];
  const push = (m) => {
    if (m && !chosen.some((c) => c.id === m.id)) chosen.push(m);
  };

  push(target);
  push(cheapest);
  push(strongest);

  // Top up to at least 2 rows, at most 3.
  pool
    .slice()
    .sort((a, b) => priceOf(a) - priceOf(b))
    .forEach(function (m) {
      if (chosen.length < 2) push(m);
    });

  const ids = chosen.slice(0, 3).map((m) => m.id);

  return ids.map((id) => {
    const m = getModel(id);
    const { low, high } = costForModel(m, classification, passes);
    let note = "";
    if (m.id === target.id) note = "Recommended for this task at this price.";
    else if (m.id === cheapest.id) note = `Cheapest option at about ${low}–${high} credits.`;
    else note = `Highest capability; costs about ${low}–${high} credits.`;
    return {
      modelId: m.id,
      low,
      high,
      capability: m.capability,
      note,
    };
  });
}

export function offlineAnalyze({ goal, requestedModel, budget, optimization }) { // exported for tests
  const trimmed = (goal || "").trim();
  const vague = isVague(trimmed);
  const classification = classify(trimmed);
  const passes = PASSES[classification.complexity] || 3;
  const factor = OPT_FACTOR[optimization] || 1;

  const target = pickTargetModel(classification, requestedModel, optimization);
  const base = costForModel(target, classification, passes);
  const low = round(base.low * factor);
  const high = round(base.high * factor);

  const recommendedMax = round(high * 1.2);
  const reserve = round(recommendedMax * 0.25);

  const phaseBreakdown = PHASES.map((phase, i) => {
    const w = PHASE_WEIGHTS[i];
    return {
      phase,
      low: round(low * w),
      high: round(high * w),
    };
  });

  const reducedLow = round(low * 0.62);
  const reducedHigh = round(high * 0.62);

  // Three reachable states:
  //   fits           - budget covers the full high estimate
  //   fits_with_cuts - budget cannot cover the full estimate, but can cover a cut version
  //   does_not_fit   - budget cannot even cover the cut version
  let status;
  if (budget >= high) status = "fits";
  else if (budget >= reducedHigh) status = "fits_with_cuts";
  else status = "does_not_fit";

  const keep =
    classification.complexity === "Low"
      ? ["Core output only", "One review pass"]
      : ["Core goal", "Main implementation", "One test pass"];
  const skip =
    status === "fits"
      ? []
      : [
          "Extra polish and styling passes",
          "Additional revision rounds",
          "Extended documentation",
          "Optional edge-case handling",
        ];

  const suggestion =
    status === "does_not_fit"
      ? `Raise the budget to about ${reducedHigh} credits, or use a cheaper model for a reduced version.`
      : status === "fits_with_cuts"
      ? `Plan for about ${high} credits to keep the full scope.`
      : `The estimate fits inside ${budget} credits with room to spare.`;

  return {
    _offline: true,
    vague,
    vagueReason: vague ? "Too little detail to estimate reliably." : "",
    classification: {
      ...classification,
      iterations: { low: Math.max(1, passes - 1), high: passes + 1 },
    },
    executionProfile: {
      passes,
      why: `${classification.complexity.toLowerCase()} complexity tasks usually need about ${passes} passes.`,
    },
    cost: { low, high, confidence: vague ? "Low" : "Medium" },
    phaseBreakdown,
    feasibility: {
      status,
      summary:
        status === "fits"
          ? `This fits your budget of ${budget} credits.`
          : status === "fits_with_cuts"
          ? `This may exceed ${budget} credits unless scope is reduced.`
          : `This does not fit ${budget} credits even with cuts.`,
      keep,
      skip,
      reducedLow,
      reducedHigh,
      minimumBudget: reducedHigh,
      suggestion,
    },
    modelRecommendation: {
      modelId: target.id,
      reason: `${target.name} handles ${classification.taskType.toLowerCase()} well at about ${low}–${high} credits.`,
    },
    modelComparison: buildComparison(target, classification, passes),
  };
}

/* ------------------------------------------------------------------ */
/* offline prompt writer                                                */
/* ------------------------------------------------------------------ */

const ROLE_BY_TYPE = {
  "Code generation": "Senior software engineer",
  "Code debugging": "Senior software engineer diagnosing a defect",
  "Code review": "Senior software engineer performing a code review",
  "Writing or editing": "Experienced editor and writer",
  "Research or summarization": "Careful research analyst",
  "Data analysis": "Data analyst",
  "Design or planning": "Software architect",
  "Automation or scripting": "Automation engineer",
  Other: "Experienced assistant",
};

function offlinePrompts(ctx) {
  const model = getModel(ctx.modelId) || MODELS[0];
  const budgetLine =
    ctx.cutsApplied && ctx.keep && ctx.keep.length
      ? `Stay within ${ctx.budget} credits. Prioritize: ${ctx.keep.join("; ")}.`
      : `Work within ${ctx.budget} credits. Recommended maximum about ${ctx.recommendedMax} credits, with about ${ctx.reserve} credits held in reserve.`;

  const tech =
    model.kind === "coding"
      ? "Name each file you create, give the exact commands to run, and include tests you can execute."
      : model.kind === "fast"
      ? "Keep responses short. Do one step at a time. Limit revisions to one round."
      : "Explain your reasoning step by step before producing the final output.";

  const phases = Array.isArray(ctx.phases) && ctx.phases.length
    ? ctx.phases.map((p) => p.phase || p).join(" -> ")
    : PHASES.join(" -> ");

  const build = (variant) => {
    const scope =
      variant === "budget_optimized"
        ? "Narrow the scope to the smallest version that still meets the objective."
        : variant === "quality"
        ? "Aim for a thorough, production-quality result with checks between phases."
        : "Produce a complete, well-structured result.";

    const passes =
      variant === "budget_optimized"
        ? Math.max(1, (ctx.passes || 3) - 1)
        : variant === "quality"
        ? (ctx.passes || 3) + 1
        : ctx.passes || 3;

    const requirements = [
      `Address the objective exactly as stated: ${ctx.goal}`,
      `Expected output size: ${ctx.outputSize || "Medium"}. Complexity: ${ctx.complexity || "Medium"}.`,
      `Work through these phases: ${phases}.`,
      scope,
      tech,
      ctx.cutsApplied && ctx.skip && ctx.skip.length
        ? `Skip these to stay in budget: ${ctx.skip.join("; ")}.`
        : "Do not add features outside the objective.",
    ];

    return [
      "ROLE",
      `You are a ${ROLE_BY_TYPE[ctx.taskType] || ROLE_BY_TYPE.Other} working on this task in ${model.name} (${model.provider}).`,
      "",
      "OBJECTIVE",
      ctx.goal,
      "",
      "REQUIREMENTS",
      requirements.map((r, i) => `${i + 1}. ${r}`).join("\n"),
      "",
      "PRIORITY ORDER",
      "1. Correctness — the objective must be met.\n2. Clarity — the output must be usable as-is.\n3. Completeness — cover the agreed scope.\n4. Polish — only if budget remains.",
      "",
      "CONSTRAINTS",
      `- Do not add scope beyond the objective.\n- Do not invent requirements.\n- State assumptions before acting on them.\n- Keep the total work to about ${passes} passes.`,
      "",
      "EXECUTION STRATEGY",
      `${phases}\nAbout ${passes} passes total. After each pass, state what changed and what remains. Pause if the next pass would exceed the budget.`,
      "",
      "BUDGET AWARENESS",
      `${budgetLine} Estimated total for this task: about ${ctx.low}-${ctx.high} credits. If you are about to exceed the budget, stop and report what is done and what remains.`,
      "",
      "STOPPING CONDITION",
      `Stop when the objective is met and the output is usable. Stop immediately if the work approaches ${ctx.recommendedMax || ctx.high} credits, and report progress instead of continuing.`,
    ].join("\n");
  };

  return {
    standard: build("standard"),
    budget_optimized: build("budget_optimized"),
    quality: build("quality"),
  };
}
