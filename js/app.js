/*
 * AgentFund — application logic.
 *
 * Phase 1: landing + input
 * Phase 2: analysis (cost range, feasibility, model recommendation)
 * Phase 3: three prompt versions, copy and edit
 * Phase 4: save to localStorage, reopen from Recent Tasks
 */

import { MODELS, AUTO_SELECT, getModel, availableModels, BUDGET_PRESETS } from "./models.mjs";
import { analyzeTask, writePrompts, healthCheck } from "./ai.js";
import {
  uid,
  getOrCreateUser,
  updateUserPreferences,
  saveTask,
  listTasks,
  getTask,
  savePrompts,
  getPromptsForTask,
  updatePromptText,
  cacheModels,
} from "./storage.js";
import {
  $,
  show,
  setNotice,
  el,
  fillKv,
  fillList,
  fillPhaseRows,
  numSpan,
  round,
  range,
} from "./dom.js";

const state = {
  user: null,
  analysis: null,
  request: null,
  cutsApplied: false,
  prompts: null,
  promptRows: [],
  activeVersion: "standard",
  taskId: null,
};

const STATUS_VIEW = {
  fits: { cls: "status fits", label: "Fits" },
  fits_with_cuts: { cls: "status cuts", label: "Fits with cuts" },
  does_not_fit: { cls: "status nofit", label: "Doesn't fit" },
};

/* ------------------------------------------------------------------ */
/* phase 1 — input                                                     */
/* ------------------------------------------------------------------ */

function byProvider() {
  const map = new Map();
  availableModels().forEach(function (m) {
    if (!map.has(m.provider)) map.set(m.provider, []);
    map.get(m.provider).push(m);
  });
  return Array.from(map.entries());
}

function buildModelSelect() {
  const select = $("model");
  select.innerHTML = "";

  const auto = document.createElement("option");
  auto.value = AUTO_SELECT;
  auto.textContent = "Auto-select the best model for me";
  select.appendChild(auto);

  byProvider().forEach(function (entry) {
    const group = document.createElement("optgroup");
    group.label = entry[0];
    entry[1].forEach(function (m) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name + " - " + m.capability.toLowerCase() + " capability";
      group.appendChild(opt);
    });
    select.appendChild(group);
  });
}

function buildBudgetPresets() {
  const row = $("budgetPresets");
  row.innerHTML = "";
  BUDGET_PRESETS.forEach(function (value) {
    const btn = el("button", "preset", String(value));
    btn.type = "button";
    btn.dataset.value = String(value);
    btn.addEventListener("click", function () {
      $("budget").value = String(value);
      highlightPresets();
    });
    row.appendChild(btn);
  });
}

function highlightPresets() {
  const current = $("budget").value;
  document.querySelectorAll(".preset").forEach(function (btn) {
    btn.classList.toggle("is-active", btn.dataset.value === current);
  });
}

function currentRequest() {
  return {
    goal: $("goal").value.trim(),
    requestedModel: $("model").value,
    optimization: $("optimization").value,
    budget: Math.max(1, Math.round(Number($("budget").value) || 1)),
  };
}

function persistPreferences() {
  const req = currentRequest();
  updateUserPreferences({
    defaultModel: req.requestedModel,
    defaultOptimization: req.optimization,
    defaultBudget: req.budget,
  });
}

async function onAnalyze() {
  const req = currentRequest();
  setNotice($("inputError"), "");

  if (!req.goal) {
    setNotice($("inputError"), "Describe the task first.");
    $("goal").focus();
    return;
  }
  if (req.goal.split(/\s+/).length < 4) {
    setNotice($("inputError"), "Add a little more detail so this can be estimated.");
    $("goal").focus();
    return;
  }
  if (!Number.isFinite(req.budget) || req.budget < 1) {
    setNotice($("inputError"), "Enter a budget of at least 1 credit.");
    $("budget").focus();
    return;
  }

  const btn = $("analyzeBtn");
  btn.disabled = true;
  btn.textContent = "Analyzing...";
  $("analyzeHint").textContent = "";

  try {
    const analysis = await analyzeTask(req);
    if (!analysis || !analysis.cost) throw new Error("no_analysis");
    state.request = req;
    state.cutsApplied = false;
    state.taskId = null;
    persistPreferences();
    renderAnalysis(analysis, req);
    show($("results"), true);
    show($("inputCard"), false);
    $("landing").classList.add("is-compact");
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    setNotice($("inputError"), "Couldn't analyze this, please try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Analyze Task";
  }
}

/* ------------------------------------------------------------------ */
/* phase 2 — render analysis                                           */
/* ------------------------------------------------------------------ */

function renderAnalysis(analysis, req) {
  state.analysis = analysis;

  const cost = analysis.cost || {};
  const low = round(cost.low);
  const high = round(cost.high);
  const recommendedMax = round(high * 1.2);
  const reserve = round(recommendedMax * 0.25);

  setNotice($("resultError"), "");
  setNotice($("resultWarning"), "");

  if (analysis._offline) {
    setNotice($("resultWarning"), "Estimated locally on this device.");
  } else if (analysis.vague) {
    setNotice($("resultWarning"), analysis.vagueReason || "This is a bit vague, so the estimate is rough.");
  }

  const f = analysis.feasibility || {};
  const statusKey = f.status || "fits";
  const view = STATUS_VIEW[statusKey] || STATUS_VIEW.fits;

  const badge = $("statusBadge");
  badge.className = view.cls;
  badge.textContent = statusMark(statusKey) + " " + view.label;
  $("statusSummary").textContent = f.summary || "";

  $("costRange").textContent = range(low, high);
  $("budgetShown").textContent = String(req.budget);
  $("recommendedMax").textContent = String(recommendedMax);
  $("reserve").textContent = String(reserve);
  $("confidence").textContent = cost.confidence || "Medium";

  const c = analysis.classification || {};
  const iter = c.iterations || {};
  fillKv($("classification"), [
    ["Task type", c.taskType || "Other"],
    ["Complexity", c.complexity || "Medium"],
    ["Output size", c.outputSize || "Medium"],
    ["Iterations", iter.low ? range(iter.low, iter.high) : "-"],
    ["External tools likely", c.externalToolsLikely ? "Yes" : "No"],
    ["Context requirement", c.contextRequirement || "Medium"],
  ]);

  const profile = analysis.executionProfile || {};
  $("executionProfile").textContent = (profile.passes || "-") + " passes. " + (profile.why || "");

  fillPhaseRows($("phaseRows"), analysis.phaseBreakdown, range);

  const needsCuts = statusKey !== "fits";
  show($("cutsCard"), needsCuts);
  if (needsCuts) {
    fillList($("keepList"), f.keep);
    fillList($("skipList"), f.skip);
    $("reducedRange").textContent = range(f.reducedLow, f.reducedHigh);
    $("optimizeState").textContent = "";
    const optBtn = $("optimizeBtn");
    optBtn.disabled = false;
    optBtn.textContent = "Optimize For My Budget";

    if (statusKey === "does_not_fit") {
      setNotice(
        $("resultError"),
        (f.suggestion || "Budget is too low for this task.") +
          " Minimum realistic budget: about " +
          round(f.minimumBudget) +
          " credits."
      );
    }
  }

  const rec = analysis.modelRecommendation || {};
  const model = getModel(rec.modelId);
  $("modelReason").textContent = model
    ? model.provider + " " + model.name + " - " + (rec.reason || "")
    : rec.reason || "";

  renderComparison(analysis.modelComparison, rec.modelId);
}

function statusMark(key) {
  if (key === "fits") return "[ok]";
  if (key === "fits_with_cuts") return "[!]";
  return "[x]";
}

function renderComparison(comparison, recommendedId) {
  const box = $("modelComparison");
  box.innerHTML = "";
  (comparison || []).forEach(function (row) {
    const m = getModel(row.modelId);
    if (!m) return;

    const div = el("div", "compare-row" + (row.modelId === recommendedId ? " is-recommended" : ""));

    const left = document.createElement("div");
    left.appendChild(el("div", "compare-name", m.provider + " " + m.name));
    left.appendChild(el("div", "compare-note", (row.capability || "") + " capability. " + (row.note || "")));

    const right = el("div", "compare-meta", range(row.low, row.high));

    div.appendChild(left);
    div.appendChild(right);
    box.appendChild(div);
  });
}

function onOptimize() {
  if (state.cutsApplied) return;
  const f = (state.analysis && state.analysis.feasibility) || {};
  state.cutsApplied = true;
  $("optimizeBtn").disabled = true;
  $("optimizeBtn").textContent = "Optimized";
  $("optimizeState").textContent =
    "Prompt will stay within " +
    state.request.budget +
    " credits and skip: " +
    ((f.skip && f.skip.join("; ")) || "extra passes") +
    ".";
  setNotice($("resultError"), "");
}

/* ------------------------------------------------------------------ */
/* phase 3 — prompts                                                   */
/* ------------------------------------------------------------------ */

function buildPromptContext() {
  const a = state.analysis;
  const req = state.request;
  const recModel = getModel((a.modelRecommendation || {}).modelId) || MODELS[0];
  const f = a.feasibility || {};
  const high = round(a.cost.high);
  const recommendedMax = round(high * 1.2);

  return {
    modelId: recModel.id,
    modelName: recModel.name,
    provider: recModel.provider,
    kind: recModel.kind,
    capability: recModel.capability,
    goal: req.goal,
    taskType: (a.classification || {}).taskType,
    complexity: (a.classification || {}).complexity,
    outputSize: (a.classification || {}).outputSize,
    iterations: (a.classification || {}).iterations,
    passes: (a.executionProfile || {}).passes,
    budget: req.budget,
    low: round(a.cost.low),
    high: high,
    recommendedMax: recommendedMax,
    reserve: round(recommendedMax * 0.25),
    optimization: req.optimization,
    cutsApplied: state.cutsApplied,
    keep: f.keep || [],
    skip: f.skip || [],
    phases: a.phaseBreakdown || [],
  };
}

function buildTaskRow(context) {
  const a = state.analysis;
  return {
    id: state.taskId || uid("tsk"),
    userId: state.user.id,
    goal: state.request.goal,
    modelId: context.modelId,
    modelName: context.modelName,
    budget: context.budget,
    optimization: context.optimization,
    complexity: context.complexity || "Medium",
    low: context.low,
    high: context.high,
    recommendedMax: context.recommendedMax,
    reserve: context.reserve,
    status: (a.feasibility || {}).status || "fits",
    cutsApplied: state.cutsApplied,
    phaseBreakdown: context.phases,
    createdAt: new Date().toISOString(),
  };
}

async function onGenerate() {
  if (!state.analysis || !state.request) return;

  const btn = $("generateBtn");
  btn.disabled = true;
  btn.textContent = "Writing prompt...";
  setNotice($("promptError"), "");

  try {
    const context = buildPromptContext();
    const prompts = await writePrompts(context);
    if (!prompts || !prompts.standard) throw new Error("no_prompt");

    state.prompts = {
      standard: prompts.standard,
      budget_optimized: prompts.budget_optimized || prompts.standard,
      quality: prompts.quality || prompts.standard,
    };

    const task = buildTaskRow(context);
    state.taskId = task.id;
    saveTask(task);
    state.promptRows = savePrompts(task.id, state.prompts);

    renderPromptSection(task);
    show($("promptSection"), true);
    renderHistory();
    $("promptSection").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    setNotice($("promptError"), "Couldn't generate the prompt. Please try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Generate Prompt";
  }
}

function renderPromptSection(task) {
  fillKv($("promptSummary"), [
    ["Goal", task.goal],
    ["Model", task.modelName],
    ["Budget", task.budget + " credits"],
    ["Estimated total", range(task.low, task.high) + " credits"],
    ["Recommended maximum", task.recommendedMax + " credits"],
    ["Reserve", task.reserve + " credits"],
  ]);
  fillPhaseRows($("promptPhaseRows"), task.phaseBreakdown, range);
  setActiveVersion("standard");
}

function setActiveVersion(version) {
  state.activeVersion = version;
  document.querySelectorAll(".version-tab").forEach(function (tab) {
    tab.classList.toggle("is-active", tab.dataset.version === version);
  });
  $("promptBox").textContent = (state.prompts && state.prompts[version]) || "";
  show($("promptView"), true);
  show($("promptEditView"), false);
  $("editToggleBtn").textContent = "Edit Prompt";
  show($("saveEditBtn"), false);
  setNotice($("copyNote"), "");
}

async function onCopy() {
  const text = (state.prompts && state.prompts[state.activeVersion]) || "";
  if (!text) return;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setNotice($("copyNote"), "Copied.");
  } catch (err) {
    setNotice($("copyNote"), "Copy failed - select the text and copy manually.");
  }
}

function onEditToggle() {
  const opening = $("promptEditView").classList.contains("hidden");
  if (opening) {
    $("promptEdit").value = (state.prompts && state.prompts[state.activeVersion]) || "";
    show($("promptView"), false);
    show($("promptEditView"), true);
    $("editToggleBtn").textContent = "Cancel Edit";
    show($("saveEditBtn"), true);
  } else {
    show($("promptView"), true);
    show($("promptEditView"), false);
    $("editToggleBtn").textContent = "Edit Prompt";
    show($("saveEditBtn"), false);
  }
  setNotice($("copyNote"), "");
}

function onSaveEdit() {
  const text = $("promptEdit").value;
  if (!state.prompts) return;
  state.prompts[state.activeVersion] = text;
  $("promptBox").textContent = text;

  const row = (state.promptRows || []).find(function (p) {
    return p.version === state.activeVersion;
  });
  if (row) updatePromptText(row.id, text);

  show($("promptView"), true);
  show($("promptEditView"), false);
  $("editToggleBtn").textContent = "Edit Prompt";
  show($("saveEditBtn"), false);
  setNotice($("copyNote"), "Edit saved.");
}

/* ------------------------------------------------------------------ */
/* phase 4 — history                                                   */
/* ------------------------------------------------------------------ */

function renderHistory() {
  const tasks = listTasks();
  const list = $("historyList");
  list.innerHTML = "";
  show($("historyCard"), tasks.length > 0);
  show($("historyEmpty"), tasks.length === 0);

  tasks.slice(0, 20).forEach(function (task) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "history-item";

    const left = document.createElement("div");
    left.appendChild(el("div", "history-goal", task.goal));
    left.appendChild(
      el(
        "div",
        "history-meta",
        task.modelName + " - " + new Date(task.createdAt).toLocaleDateString()
      )
    );

    const right = el("div", "history-right", range(task.low, task.high));

    btn.appendChild(left);
    btn.appendChild(right);
    btn.addEventListener("click", function () {
      openSavedTask(task.id);
    });
    list.appendChild(btn);
  });
}

function openSavedTask(id) {
  const task = getTask(id);
  if (!task) return;

  const rows = getPromptsForTask(id);
  const prompts = {};
  rows.forEach(function (r) {
    prompts[r.version] = r.text;
  });
  if (!prompts.standard) return;

  state.taskId = task.id;
  state.cutsApplied = !!task.cutsApplied;
  state.prompts = {
    standard: prompts.standard,
    budget_optimized: prompts.budget_optimized || prompts.standard,
    quality: prompts.quality || prompts.standard,
  };
  state.promptRows = rows;
  state.request = {
    goal: task.goal,
    requestedModel: task.modelId,
    optimization: task.optimization,
    budget: task.budget,
  };
  state.analysis = {
    cost: { low: task.low, high: task.high, confidence: "Medium" },
    classification: { complexity: task.complexity },
    executionProfile: { passes: null, why: "" },
    phaseBreakdown: task.phaseBreakdown || [],
    feasibility: { status: task.status },
    modelRecommendation: { modelId: task.modelId },
  };

  renderPromptSection(task);
  show($("results"), false);
  show($("inputCard"), false);
  show($("promptSection"), true);
  $("landing").classList.add("is-compact");
  $("promptSection").scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ------------------------------------------------------------------ */
/* navigation                                                          */
/* ------------------------------------------------------------------ */

function onBack() {
  show($("results"), false);
  show($("promptSection"), false);
  show($("inputCard"), true);
  $("goal").focus();
}

function onNewTask() {
  state.analysis = null;
  state.request = null;
  state.prompts = null;
  state.promptRows = [];
  state.cutsApplied = false;
  state.taskId = null;
  $("goal").value = "";
  show($("promptSection"), false);
  show($("results"), false);
  show($("inputCard"), true);
  $("landing").classList.remove("is-compact");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

async function init() {
  state.user = getOrCreateUser();
  cacheModels(MODELS);

  buildModelSelect();
  buildBudgetPresets();

  const prefs = state.user.preferences || {};
  if (prefs.defaultModel) $("model").value = prefs.defaultModel;
  if (prefs.defaultOptimization) $("optimization").value = prefs.defaultOptimization;
  if (prefs.defaultBudget) $("budget").value = String(prefs.defaultBudget);
  highlightPresets();

  $("startBtn").addEventListener("click", function () {
    $("landing").classList.add("is-compact");
    show($("inputCard"), true);
    $("goal").focus();
  });
  $("analyzeBtn").addEventListener("click", onAnalyze);
  $("optimizeBtn").addEventListener("click", onOptimize);
  $("generateBtn").addEventListener("click", onGenerate);
  $("backBtn").addEventListener("click", onBack);
  $("copyBtn").addEventListener("click", onCopy);
  $("editToggleBtn").addEventListener("click", onEditToggle);
  $("saveEditBtn").addEventListener("click", onSaveEdit);
  $("newTaskBtn").addEventListener("click", onNewTask);
  $("budget").addEventListener("input", highlightPresets);

  document.querySelectorAll(".version-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      setActiveVersion(tab.dataset.version);
    });
  });

  renderHistory();

  const health = await healthCheck();
  $("modeNote").textContent = health.online
    ? "AI analysis enabled"
    : "Local estimator (no API key)";
}

init();
