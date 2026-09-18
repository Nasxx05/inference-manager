/*
 * AgentFund — storage.
 *
 * Browser localStorage, but shaped like four tables so a real database
 * can replace this file later without touching the UI:
 *   af_users, af_tasks, af_prompts, af_models
 *
 * No accounts, no login. A single anonymous user row is created once.
 */

const KEYS = {
  users: "af_users",
  tasks: "af_tasks",
  prompts: "af_prompts",
  models: "af_models",
};

function readTable(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function writeTable(key, rows) {
  try {
    localStorage.setItem(key, JSON.stringify(rows));
  } catch (err) {
    // Storage full or unavailable — the app still works in memory.
  }
}

export function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/* ---------------- users ---------------- */

export function getOrCreateUser() {
  const users = readTable(KEYS.users);
  if (users.length > 0) return users[0];
  const user = {
    id: uid("usr"),
    email: null,
    preferences: {
      defaultModel: "auto",
      defaultOptimization: "Balanced",
      defaultBudget: 10,
    },
    createdAt: new Date().toISOString(),
  };
  writeTable(KEYS.users, [user]);
  return user;
}

export function updateUserPreferences(patch) {
  const user = getOrCreateUser();
  const next = {
    ...user,
    preferences: { ...user.preferences, ...patch },
  };
  writeTable(KEYS.users, [next]);
  return next;
}

/* ---------------- tasks ---------------- */

export function saveTask(task) {
  const tasks = readTable(KEYS.tasks);
  const index = tasks.findIndex((t) => t.id === task.id);
  if (index === -1) {
    tasks.unshift(task);
  } else {
    tasks[index] = task;
  }
  writeTable(KEYS.tasks, tasks.slice(0, 200));
  return task;
}

export function listTasks() {
  return readTable(KEYS.tasks).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
}

export function getTask(id) {
  return readTable(KEYS.tasks).find((t) => t.id === id) || null;
}

export function deleteTask(id) {
  const tasks = readTable(KEYS.tasks).filter((t) => t.id !== id);
  writeTable(KEYS.tasks, tasks);
  const prompts = readTable(KEYS.prompts).filter((p) => p.taskId !== id);
  writeTable(KEYS.prompts, prompts);
}

/* ---------------- prompts ---------------- */

export function savePrompts(taskId, versions) {
  const prompts = readTable(KEYS.prompts).filter((p) => p.taskId !== taskId);
  const rows = Object.entries(versions).map(([version, text]) => ({
    id: uid("prm"),
    taskId,
    version,
    text,
    createdAt: new Date().toISOString(),
  }));
  writeTable(KEYS.prompts, rows.concat(prompts));
  return rows;
}

export function getPromptsForTask(taskId) {
  return readTable(KEYS.prompts).filter((p) => p.taskId === taskId);
}

export function updatePromptText(promptId, text) {
  const prompts = readTable(KEYS.prompts);
  const index = prompts.findIndex((p) => p.id === promptId);
  if (index === -1) return null;
  prompts[index] = { ...prompts[index], text, updatedAt: new Date().toISOString() };
  writeTable(KEYS.prompts, prompts);
  return prompts[index];
}

/* ---------------- models cache ---------------- */

export function cacheModels(models) {
  writeTable(KEYS.models, models);
}

export function cachedModels() {
  return readTable(KEYS.models);
}