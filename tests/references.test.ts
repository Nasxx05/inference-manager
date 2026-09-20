/**
 * Reference (image + website URL) tests.
 *
 * The most important test here is the text-only regression at the bottom: the
 * same task run with and without an image must behave identically except for
 * the reference-aware parts. If adding a reference changes model resolution,
 * scope or budget behaviour, the feature is wrong.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildPlan } from "@/lib/planner";
import {
  MAX_IMAGE_BYTES,
  MAX_REFERENCES,
  type ReferenceAnalysis,
  type ReferenceInput,
} from "@/lib/reference/types";
import { detectUrls, checkUrl } from "@/lib/reference/urlSafety";
import { checkImage } from "@/lib/reference/imageValidation";
import { normalizeReferences } from "@/lib/reference/normalizer";
import { referenceWorkload } from "@/lib/reference/workload";
import { describeReferenceForPrompt, buildImageMessage } from "@/lib/reference/referenceAnalyzer";
import { analyzeInspection } from "@/lib/reference/referenceAnalyzer";
import { statusForCode } from "@/lib/ai/errors";

const VALID_PROMPT = [
  "ROLE",
  "You are a senior engineer.",
  "OBJECTIVE",
  "Deliver the requested work.",
  "CONTEXT",
  "The requester described a task.",
  "REQUIREMENTS",
  "- Meet every stated requirement.",
  "ASSUMED DEFAULTS",
  "- Restate your assumptions.",
  "STRUCTURE AND ARCHITECTURE",
  "- Organise the work into clear parts.",
  "SCOPE",
  "- Deliver what is in scope.",
  "OUT OF SCOPE",
  "- Do not build deferred items.",
  "PRIORITIES",
  "- Correctness first.",
  "EXECUTION STRATEGY",
  "- Work in one pass, then validate.",
  "CONSTRAINTS",
  "- Stay within the stated budget.",
  "BUDGET CONSTRAINT",
  "- Stop if the budget is exhausted.",
  "VALIDATION",
  "- Check the output against the requirements.",
  "REVISION POLICY",
  "- Use targeted corrections.",
  "STOPPING CONDITIONS",
  "- Stop when requirements pass.",
  "OUTPUT FORMAT",
  "- Return the finished work.",
].join("\n");

const ANALYSIS = {
  taskType: "web-development",
  complexity: "high",
  summary: "A portfolio site build with several optional sections.",
  requiredCapabilities: ["coding"],
  estimatedInputTokens: 20000,
  estimatedOutputTokens: 12000,
  expectedIterations: 4,
  phases: [
    { name: "Core implementation", description: "Build the core", costWeight: 0.5, priority: "essential" },
    { name: "Analytics", description: "Add analytics", costWeight: 0.3, priority: "optional" },
    { name: "Reporting", description: "Add reporting", costWeight: 0.2, priority: "optional" },
  ],
  risks: ["scope creep"],
};

/** Minimal valid PNG, JPEG and WEBP headers. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x40, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP"),
  Buffer.alloc(32, 1),
]);
const NOT_AN_IMAGE = Buffer.alloc(128, 7);

function imageAnalysis(overrides: Partial<ReferenceAnalysis> = {}): ReferenceAnalysis {
  return {
    id: "ref:image:0",
    type: "image",
    kind: "visual_web_reference",
    summary: "A centred hero with oversized serif headings and a restrained two-colour palette.",
    layout: { navigation: "top bar", hero: "centred, oversized heading", sections: "three stacked", footer: "minimal" },
    visualStyle: { colors: ["#111111", "#f5f5f5"], typography: "large serif headings", spacing: "generous" },
    components: ["card grid", "primary button"],
    interactions: ["hover lift on cards"],
    responsiveObservations: ["single column on narrow widths"],
    notablePatterns: ["strong type hierarchy"],
    uncertainties: ["exact font family unclear"],
    visual: true,
    source: "multimodal image analysis",
    ...overrides,
  };
}

function stubProvider(response: unknown) {
  return vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const wantsJson = body.response_format?.type === "json_object";
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: "chatcmpl-test",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: wantsJson ? JSON.stringify(response) : VALID_PROMPT },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
      }),
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: { content: wantsJson ? JSON.stringify(response) : VALID_PROMPT },
              finish_reason: "stop",
            },
          ],
        }),
    } as unknown as Response;
  });
}

const COMBINED = { analysis: ANALYSIS, prompt: VALID_PROMPT };

beforeEach(() => {
  process.env.AGENTFUND_AI_BASE_URL = "https://example.test/v1";
  process.env.AGENTFUND_AI_API_KEY = "test-key";
  process.env.AGENTFUND_AI_MODEL = "test-model";
  process.env.AGENTFUND_AI_COMBINED = "1";
  delete process.env.AGENTFUND_AI_MULTIMODAL_MODEL;
  vi.stubGlobal("fetch", stubProvider(COMBINED));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.AGENTFUND_AI_MULTIMODAL_MODEL;
});

/* ------------------------------------------------------------------ */
/* URL detection and validation                                        */
/* ------------------------------------------------------------------ */

describe("URL references", () => {
  it("detects an https URL in task text", () => {
    expect(detectUrls("Build a portfolio like https://example.com")).toEqual([
      "https://example.com",
    ]);
  });

  it("does not treat bare text or trailing punctuation as a URL", () => {
    expect(detectUrls("see example.com for details")).toEqual([]);
    expect(detectUrls("visit https://example.com.")).toEqual(["https://example.com"]);
  });

  it("de-duplicates repeated URLs", () => {
    expect(detectUrls("https://a.com and https://a.com")).toEqual(["https://a.com"]);
  });

  it("rejects unsupported protocols", () => {
    const check = checkUrl("ftp://example.com");
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.code).toBe("UNSUPPORTED_PROTOCOL");
  });

  it("rejects an invalid URL", () => {
    const check = checkUrl("not a url");
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.code).toBe("INVALID_REFERENCE_URL");
  });

  it("blocks localhost", () => {
    expect(checkUrl("http://localhost:3000").ok).toBe(false);
    expect(checkUrl("http://127.0.0.1").ok).toBe(false);
  });

  it("blocks private IP ranges", () => {
    expect(checkUrl("http://10.0.0.5").ok).toBe(false);
    expect(checkUrl("http://192.168.1.1").ok).toBe(false);
    expect(checkUrl("http://172.16.0.1").ok).toBe(false);
  });

  it("blocks link-local and cloud metadata addresses", () => {
    expect(checkUrl("http://169.254.169.254").ok).toBe(false);
    expect(checkUrl("http://metadata.google.internal").ok).toBe(false);
  });

  it("maps blocked URLs to a 400 status", () => {
    expect(statusForCode("BLOCKED_REFERENCE_URL")).toBe(400);
    expect(statusForCode("WEBSITE_UNAVAILABLE")).toBe(422);
    expect(statusForCode("WEBSITE_FETCH_TIMEOUT")).toBe(422);
  });
});

/* ------------------------------------------------------------------ */
/* Image validation                                                    */
/* ------------------------------------------------------------------ */

describe("image references", () => {
  it("accepts PNG, JPEG and WEBP", () => {
    for (const [name, buf, mime] of [
      ["png", PNG, "image/png"],
      ["jpeg", JPEG, "image/jpeg"],
      ["webp", WEBP, "image/webp"],
    ] as const) {
      const result = checkImage({ buffer: buf, declaredMimeType: mime });
      expect(result.ok, name).toBe(true);
      if (result.ok) expect(result.reference.mimeType).toBe(mime);
    }
  });

  it("rejects an unsupported file", () => {
    const result = checkImage({ buffer: NOT_AN_IMAGE, filename: "notes.txt" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNSUPPORTED_IMAGE_TYPE");
  });

  it("rejects an oversized image", () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES + 10, 3)]);
    const result = checkImage({ buffer: big });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("IMAGE_TOO_LARGE");
  });

  it("rejects a declared type that disagrees with the bytes", () => {
    const result = checkImage({ buffer: PNG, declaredMimeType: "image/jpeg" });
    expect(result.ok).toBe(false);
  });

  it("builds the provider image payload as a data URL", () => {
    const messages = buildImageMessage({
      prompt: "analyse",
      image: { type: "image", mimeType: "image/png", base64: "AAA", filename: "a.png" },
    });
    const user = messages[1]!;
    expect(Array.isArray(user.content)).toBe(true);
    const parts = user.content as Array<{ type: string; image_url?: { url: string } }>;
    const image = parts.find((p) => p.type === "image_url");
    expect(image?.image_url?.url).toBe("data:image/png;base64,AAA");
  });

  it("requires a multimodal model before claiming to have seen an image", async () => {
    const { analyzeImageReference } = await import("@/lib/reference/referenceAnalyzer");
    await expect(
      analyzeImageReference({ type: "image", mimeType: "image/png", base64: "AAA" }, 0),
    ).rejects.toMatchObject({ code: "REFERENCE_ANALYSIS_FAILED" });
  });
});

/* ------------------------------------------------------------------ */
/* Normalization and workload                                          */
/* ------------------------------------------------------------------ */

describe("reference normalization", () => {
  it("returns an empty list for a text-only task", () => {
    const result = normalizeReferences({ taskDescription: "Build a SaaS landing page." });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.references).toEqual([]);
  });

  it("turns a typed URL into a website reference", () => {
    const result = normalizeReferences({
      taskDescription: "Build a portfolio similar to https://example.com",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.references).toHaveLength(1);
      expect(result.references[0]!.type).toBe("website");
    }
  });

  it("rejects more than the maximum number of references", () => {
    const images = Array.from({ length: MAX_REFERENCES + 1 }, () => ({
      buffer: PNG,
      filename: "a.png",
    }));
    const result = normalizeReferences({ taskDescription: "task", images });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TOO_MANY_REFERENCES");
  });
});

describe("reference workload", () => {
  it("is a no-op for no references", () => {
    expect(referenceWorkload([])).toEqual({ addedRequirements: 0, effortMultiplier: 1, driver: "" });
  });

  it("adds bounded workload and a human-readable driver", () => {
    const workload = referenceWorkload([imageAnalysis()]);
    expect(workload.addedRequirements).toBeGreaterThan(0);
    expect(workload.effortMultiplier).toBeGreaterThan(1);
    expect(workload.driver).toContain("Image reference analysis adds planning work.");
  });
});

/* ------------------------------------------------------------------ */
/* Website analysis honesty                                            */
/* ------------------------------------------------------------------ */

describe("website analysis", () => {
  const inspection = {
    ok: true as const,
    url: "https://example.com",
    finalUrl: "https://example.com",
    title: "Example",
    metaDescription: "A site",
    headings: ["Welcome"],
    navLabels: ["Home", "About"],
    sections: ["header", "navigation"],
    components: ["form"],
    textSample: "Hello world",
    frameworkHints: ["Next.js"],
    screenshot: false as const,
  };

  it("does not fabricate visual style when the page was not rendered", async () => {
    const analysis = await analyzeInspection(inspection, 0);
    expect(analysis.visual).toBe(false);
    expect(analysis.uncertainties.join(" ")).toMatch(/not rendered|not assessed/i);
  });

  it("describes a reference as actionable instructions, not a pointer", () => {
    const text = describeReferenceForPrompt(imageAnalysis());
    expect(text).toContain("Layout —");
    expect(text).toContain("oversized serif headings");
    expect(text).not.toMatch(/see attached image/i);
  });
});

/* ------------------------------------------------------------------ */
/* Planning integration                                                */
/* ------------------------------------------------------------------ */

describe("planning with references", () => {
  const TASK = "Build a portfolio website inspired by this design.";

  it("keeps the original task authoritative and exposes the analysis", async () => {
    const plan = await buildPlan({
      taskDescription: TASK,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 50,
      referenceAnalysis: [imageAnalysis()],
    });

    expect(plan.taskDescription).toBe(TASK);
    expect(plan.referenceAnalysis).toHaveLength(1);
    expect(plan.referenceAnalysis![0]!.type).toBe("image");
  });

  it("uses the same resolved model and canonical scope as text-only", async () => {
    const withRef = await buildPlan({
      taskDescription: TASK,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 50,
      referenceAnalysis: [imageAnalysis()],
    });
    const without = await buildPlan({
      taskDescription: TASK,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 50,
    });

    expect(withRef.modelId).toBe(without.modelId);
    expect(withRef.promptModelId).toBe(withRef.modelId);
    expect(withRef.cost.modelId).toBe(withRef.modelId);
    // One canonical scope, still present and intact.
    expect(withRef.finalScope).toBeDefined();
    expect(withRef.finalScope!.requirements.length).toBe(
      without.finalScope!.requirements.length,
    );
  });

  it("does not bypass budget feasibility when a reference is present", async () => {
    const plan = await buildPlan({
      taskDescription: TASK,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 0.001,
      applyOptimizedScope: true,
      referenceAnalysis: [imageAnalysis()],
    });

    // The scope optimizer still runs and still reports insufficiency.
    expect(plan.optimizationInsufficient).toBe(true);
    expect(plan.feasibility.status).toBeDefined();
  });

  it("still resolves Auto to a concrete model with a reference present", async () => {
    const plan = await buildPlan({
      taskDescription: TASK,
      modelId: "auto",
      optimization: "balanced",
      budget: 50,
      referenceAnalysis: [imageAnalysis()],
    });

    expect(plan.autoSelected).toBe(true);
    expect(plan.modelId).not.toBe("auto");
    expect(plan.promptModelId).toBe(plan.modelId);
    expect(plan.cost.modelId).toBe(plan.modelId);
  });

  /**
   * The brief must reach the writer as translated instructions, so the final
   * prompt is usable by a model that never sees the image.
   */
  it("passes the reference brief into prompt generation", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        seen.push(String(init?.body ?? ""));
        const body = JSON.parse(String(init?.body ?? "{}"));
        const wantsJson = body.response_format?.type === "json_object";
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "c",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: wantsJson ? JSON.stringify(COMBINED) : VALID_PROMPT,
                },
                finish_reason: "stop",
              },
            ],
            usage: {},
          }),
          text: async () =>
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: wantsJson ? JSON.stringify(COMBINED) : VALID_PROMPT,
                  },
                  finish_reason: "stop",
                },
              ],
            }),
        } as unknown as Response;
      }),
    );

    await buildPlan({
      taskDescription: TASK,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 50,
      referenceAnalysis: [imageAnalysis()],
    });

    const combined = seen.join(" ");
    expect(combined).toContain("DESIGN REFERENCE");
    expect(combined).toContain("oversized serif headings");
    // And it must instruct an original implementation, not a copy.
    expect(combined).toMatch(/ORIGINAL|original implementation/i);
  });

  it("adds no reference block at all for a text-only request", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        seen.push(String(init?.body ?? ""));
        const body = JSON.parse(String(init?.body ?? "{}"));
        const wantsJson = body.response_format?.type === "json_object";
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "c",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: wantsJson ? JSON.stringify(COMBINED) : VALID_PROMPT,
                },
                finish_reason: "stop",
              },
            ],
            usage: {},
          }),
          text: async () =>
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: wantsJson ? JSON.stringify(COMBINED) : VALID_PROMPT,
                  },
                  finish_reason: "stop",
                },
              ],
            }),
        } as unknown as Response;
      }),
    );

    await buildPlan({
      taskDescription: TASK,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 50,
    });

    const combined = seen.join(" ");
    expect(combined).not.toContain("DESIGN REFERENCE");
    expect(combined).not.toContain("reference");
  });

  it("supports text + image + website together without corrupting the plan", async () => {
    const plan = await buildPlan({
      taskDescription: `${TASK} Similar to https://example.com`,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 50,
      referenceAnalysis: [
        imageAnalysis(),
        imageAnalysis({
          id: "ref:website:0",
          type: "website",
          summary: "A marketing site with a three-column feature grid.",
          visual: false,
          source: "page structure and metadata (not rendered)",
        }),
      ],
    });

    expect(plan.referenceAnalysis).toHaveLength(2);
    expect(plan.referenceAnalysis!.map((r) => r.type).sort()).toEqual(["image", "website"]);
    expect(plan.taskDescription).toContain("https://example.com");
    expect(plan.finalScope).toBeDefined();
    expect(plan.promptModelId).toBe(plan.modelId);
    expect(plan.cost.modelId).toBe(plan.modelId);
  });
});

/* ------------------------------------------------------------------ */
/* THE MOST IMPORTANT REGRESSION TEST                                  */
/* ------------------------------------------------------------------ */

describe("text-only vs reference-aware", () => {
  const TASK = "Build a SaaS landing page for a fintech company.";

  it("behaves identically except for the reference-aware parts", async () => {
    const textOnly = await buildPlan({
      taskDescription: TASK,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 20,
    });

    const withImage = await buildPlan({
      taskDescription: TASK,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 20,
      referenceAnalysis: [imageAnalysis()],
    });

    // CASE A: existing behaviour remains valid.
    expect(textOnly.modelId).toBe("claude-sonnet");
    expect(textOnly.promptModelId).toBe(textOnly.modelId);
    expect(textOnly.cost.modelId).toBe(textOnly.modelId);
    expect(textOnly.finalScope).toBeDefined();
    expect(textOnly.prompt).toContain("ROLE");
    expect(textOnly.referenceAnalysis).toBeUndefined();

    // CASE B: the reference EXTENDS planning rather than replacing it.
    expect(withImage.modelId).toBe(textOnly.modelId);
    expect(withImage.promptModelId).toBe(textOnly.promptModelId);
    expect(withImage.taskDescription).toBe(TASK);
    expect(withImage.prompt).toContain("ROLE");
    expect(withImage.finalScope!.requirements.length).toBe(
      textOnly.finalScope!.requirements.length,
    );
    expect(withImage.referenceAnalysis).toHaveLength(1);

    // And the estimate reflects the extra planning work, transparently.
    expect(withImage.referenceCostDriver).toBeTruthy();
  });
});
