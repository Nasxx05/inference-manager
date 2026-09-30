import { inspectWebsite } from "@/lib/reference/websiteInspector";
import type { LiveProductSnapshot, RepositorySnapshot } from "@/types/iteration";
import { PersistenceError } from "./persistence";

const MAX_RELEVANT_FILES = 24;
const MAX_FILE_BYTES = 120_000;
const MAX_EVIDENCE_CHARS = 60_000;

export interface GithubCiEvidence {
  available: boolean;
  commitSha: string;
  status: "passed" | "failed" | "running" | "unavailable";
  workflowRuns: Array<{ name: string; status: string; conclusion?: string; url?: string }>;
  summary: string;
  checkedAt: string;
}

function githubParts(value: string): { owner: string; name: string } {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new PersistenceError("REPOSITORY_FETCH_FAILED", "Enter a valid GitHub repository URL.", 400); }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") throw new PersistenceError("REPOSITORY_FETCH_FAILED", "Only HTTPS GitHub repository URLs are supported.", 400);
  const parts = url.pathname.split("/").filter(Boolean).slice(0, 2);
  if (parts.length !== 2 || parts.some((part) => !/^[a-zA-Z0-9_.-]+$/.test(part))) throw new PersistenceError("REPOSITORY_FETCH_FAILED", "Use a GitHub URL in the form https://github.com/owner/repository.", 400);
  return { owner: parts[0]!, name: parts[1]!.replace(/\.git$/, "") };
}

function headers(): Record<string, string> {
  const token = String(process.env.GITHUB_TOKEN ?? "").trim();
  return { Accept: "application/vnd.github+json", "User-Agent": "PromgentReviewAgent/1.0", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

async function githubJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { headers: headers(), signal: controller.signal });
    if (response.status === 401 || response.status === 403) throw new PersistenceError("REPOSITORY_FETCH_FAILED", "GitHub did not allow this repository request.", 502);
    if (response.status === 404) throw new PersistenceError("REPOSITORY_FETCH_FAILED", "That GitHub repository was not found or is not publicly accessible.", 404);
    if (!response.ok) throw new PersistenceError("REPOSITORY_FETCH_FAILED", "GitHub could not provide the repository evidence.", 502);
    const raw = await response.text();
    if (raw.length > 2_000_000) throw new PersistenceError("REPOSITORY_TOO_LARGE", "The repository response was too large to inspect.", 413);
    return JSON.parse(raw) as T;
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError("REPOSITORY_FETCH_FAILED", "The repository could not be reached.", 502);
  } finally { clearTimeout(timer); }
}

function redact(value: string): string {
  return value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, "[REDACTED_TOKEN]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED_AWS_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/(api[_-]?key|service[_-]?role|secret|password|token|database[_-]?url|private[_-]?key)\s*[:=]\s*["']?[^\s"']{8,}/gi, "$1=[REDACTED_SECRET]");
}

function relevant(path: string): boolean {
  if (path.startsWith(".git/") || /(^|\/)(node_modules|vendor|dist|build|coverage)(\/|$)/.test(path)) return false;
  return /\.(tsx?|jsx?|mjs|cjs|json|md|sql|prisma|yml|yaml|css|html|py|go|java|rb|php)$/i.test(path)
    || /(^|\/)(package\.json|Dockerfile|docker-compose\.yml|README|\.env\.example)$/i.test(path);
}

function searchTerms(values: string[]): Set<string> {
  return new Set(values.join(" ").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((term) => term.length >= 4).slice(0, 120));
}

function rankFile(path: string, terms: Set<string>, changed: Set<string>): number {
  const lower = path.toLowerCase();
  let score = changed.has(path) ? 100 : 0;
  if (/(^|\/)(package\.json|readme|dockerfile|.*schema.*|.*migration.*|.*route.*|.*page.*|.*app.*|.*main.*|.*index.*)$/i.test(path)) score += 25;
  if (/(test|spec|__tests__)/i.test(path)) score += 18;
  if (/(auth|payment|database|schema|route|api|middleware|config)/i.test(path)) score += 12;
  for (const term of terms) if (lower.includes(term)) score += 4;
  return score;
}

export async function inspectRepository(repositoryUrl: string, options: { previousCommitSha?: string; requirementText?: string[] } = {}): Promise<RepositorySnapshot> {
  const { owner, name } = githubParts(repositoryUrl);
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const metadata = await githubJson<{ default_branch?: string }>(base);
  const branch = String(metadata.default_branch ?? "main");
  const commit = await githubJson<{ sha?: string }>(`${base}/commits/${encodeURIComponent(branch)}`);
  const commitSha = String(commit.sha ?? "");
  if (!commitSha) throw new PersistenceError("REPOSITORY_FETCH_FAILED", "GitHub did not return a commit for the default branch.", 502);
  const tree = await githubJson<{ truncated?: boolean; tree?: Array<{ path?: string; type?: string; size?: number }> }>(`${base}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`);
  const files = (tree.tree ?? []).filter((item) => item.type === "blob" && item.path).map((item) => ({ path: String(item.path), size: Number(item.size ?? 0) }));
  let changedFiles: string[] = [];
  let comparisonUrl: string | undefined;
  if (options.previousCommitSha && options.previousCommitSha !== commitSha) {
    try {
      const comparison = await githubJson<{ html_url?: string; files?: Array<{ filename?: string }> }>(`${base}/compare/${encodeURIComponent(options.previousCommitSha)}...${encodeURIComponent(commitSha)}`);
      changedFiles = (comparison.files ?? []).map((item) => String(item.filename ?? "")).filter(Boolean).slice(0, 300);
      comparisonUrl = String(comparison.html_url ?? "") || undefined;
    } catch { /* A compare failure falls back to a bounded full snapshot. */ }
  }
  const changed = new Set(changedFiles);
  const terms = searchTerms(options.requirementText ?? []);
  const selected = files.filter((item) => relevant(item.path)).sort((a, b) => rankFile(b.path, terms, changed) - rankFile(a.path, terms, changed) || a.path.localeCompare(b.path)).slice(0, MAX_RELEVANT_FILES);
  const chunks: string[] = [`Repository: ${owner}/${name}`, `Branch: ${branch}`, `Commit: ${commitSha}`, `File count: ${files.length}${tree.truncated ? " (GitHub tree was truncated)" : ""}`, "Relevant files:", ...selected.map((item) => `- ${item.path}${item.size ? ` (${item.size} bytes)` : ""}`)];
  let remaining = MAX_EVIDENCE_CHARS - chunks.join("\n").length;
  for (const file of selected) {
    if (remaining <= 0 || file.size > MAX_FILE_BYTES) continue;
    try {
      const response = await fetch(`https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${encodeURIComponent(commitSha)}/${file.path.split("/").map(encodeURIComponent).join("/")}`, { headers: { "User-Agent": "PromgentReviewAgent/1.0" } });
      if (!response.ok) continue;
      const raw = await response.text();
      const safe = redact(raw.slice(0, Math.min(MAX_FILE_BYTES, remaining)));
      chunks.push(`\n--- UNTRUSTED REPOSITORY DATA: ${file.path} ---\n${safe}`);
      remaining -= safe.length + file.path.length + 60;
    } catch { /* One inaccessible file must not discard the repository review. */ }
  }
  return { repositoryUrl, owner, name, branch, commitSha, ...(options.previousCommitSha ? { previousCommitSha: options.previousCommitSha } : {}), ...(changedFiles.length ? { changedFiles } : {}), ...(comparisonUrl ? { comparisonUrl } : {}), unchanged: Boolean(options.previousCommitSha && options.previousCommitSha === commitSha), reviewedAt: new Date().toISOString(), fileCount: files.length, relevantFiles: selected.map((item) => item.path), structuralSummary: chunks.slice(0, 6).join("\n"), evidenceText: chunks.join("\n").slice(0, MAX_EVIDENCE_CHARS), status: "reviewed" };
}

export async function inspectGithubActions(snapshot: RepositorySnapshot): Promise<GithubCiEvidence> {
  const checkedAt = new Date().toISOString();
  if (!snapshot.owner || !snapshot.name || !snapshot.commitSha)
    return { available: false, commitSha: snapshot.commitSha ?? "", status: "unavailable", workflowRuns: [], summary: "No exact repository commit was available for CI inspection.", checkedAt };
  try {
    const data = await githubJson<{ workflow_runs?: Array<{ name?: string; status?: string; conclusion?: string | null; html_url?: string; head_sha?: string }> }>(
      `https://api.github.com/repos/${encodeURIComponent(snapshot.owner)}/${encodeURIComponent(snapshot.name)}/actions/runs?head_sha=${encodeURIComponent(snapshot.commitSha)}&per_page=20`,
    );
    const runs = (data.workflow_runs ?? [])
      .filter((run) => run.head_sha === snapshot.commitSha)
      .map((run) => ({ name: String(run.name ?? "GitHub Actions"), status: String(run.status ?? "unknown"), ...(run.conclusion ? { conclusion: String(run.conclusion) } : {}), ...(run.html_url ? { url: String(run.html_url) } : {}) }));
    if (!runs.length)
      return { available: false, commitSha: snapshot.commitSha, status: "unavailable", workflowRuns: [], summary: `No GitHub Actions run was found for commit ${snapshot.commitSha.slice(0, 12)}. Tests may exist in source, but Promgent cannot claim they passed.`, checkedAt };
    const running = runs.some((run) => run.status !== "completed");
    const failed = runs.some((run) => run.status === "completed" && !["success", "neutral", "skipped"].includes(run.conclusion ?? ""));
    const status = running ? "running" : failed ? "failed" : "passed";
    return { available: true, commitSha: snapshot.commitSha, status, workflowRuns: runs, summary: `GitHub Actions evidence for exact commit ${snapshot.commitSha.slice(0, 12)}: ${runs.map((run) => `${run.name} — ${run.status}${run.conclusion ? `/${run.conclusion}` : ""}`).join("; ")}.`, checkedAt };
  } catch (error) {
    return { available: false, commitSha: snapshot.commitSha, status: "unavailable", workflowRuns: [], summary: error instanceof Error ? `GitHub Actions evidence was unavailable: ${error.message}` : "GitHub Actions evidence was unavailable.", checkedAt };
  }
}

export async function inspectLiveProduct(url: string): Promise<LiveProductSnapshot> {
  const inspectedAt = new Date().toISOString();
  const result = await inspectWebsite(url);
  if (!result.ok) return { url, inspectedAt, status: "unavailable", error: result.message };
  return { url, inspectedAt, status: "reviewed", title: result.title, headings: result.headings, sections: result.sections, components: result.components, textSample: result.textSample };
}
