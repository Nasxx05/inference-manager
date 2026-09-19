/**
 * Configuration resolution for AgentFund's internal model.
 *
 * These cover the rename from AI_* to AGENTFUND_AI_*, which has to be safe in
 * both directions: a stale AI_MODEL left in a dashboard must not quietly win
 * over AGENTFUND_AI_MODEL (that would make changing the documented variable
 * look like it had no effect and pin the deployment to one vendor), while a
 * deployment still on the old names must keep working.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ENV,
  aiAnalysisMaxTokens,
  aiBaseUrl,
  aiCombinedEnabled,
  aiCombinedMaxTokens,
  aiModel,
  aiPromptMaxTokens,
  aiProviderConfigured,
  aiTimeoutMs,
  legacyMaxTokensPresent,
  missingConfig,
  usingLegacyEnvNames,
} from "@/lib/ai/env";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("AGENTFUND_AI_") || /^AI_(API_KEY|BASE_URL|MODEL|MAX_TOKENS|TIMEOUT_MS)$/.test(key)) {
      delete process.env[key];
    }
  }
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("env configuration", () => {
  it("reports every required variable as missing when nothing is set", () => {
    expect(aiProviderConfigured()).toBe(false);
    expect(aiModel()).toBeUndefined();
    expect(missingConfig()).toEqual([ENV.API_KEY, ENV.BASE_URL, ENV.MODEL]);
  });

  it("never invents a model when AGENTFUND_AI_MODEL is unset", () => {
    process.env.AGENTFUND_AI_API_KEY = "k";
    process.env.AGENTFUND_AI_BASE_URL = "https://example.test/v1";

    // A guessed default would make an unconfigured deployment look configured
    // and fail deep inside the provider call instead of at the boundary.
    expect(aiModel()).toBeUndefined();
    expect(aiProviderConfigured()).toBe(false);
  });

  it("prefers AGENTFUND_AI_MODEL over a stale AI_MODEL", () => {
    process.env.AGENTFUND_AI_MODEL = "vendor-a/model-one";
    process.env.AI_MODEL = "vendor-b/old-pinned-model";

    expect(aiModel()).toBe("vendor-a/model-one");
  });

  it("falls back to AI_MODEL only when AGENTFUND_AI_MODEL is unset", () => {
    process.env.AI_MODEL = "vendor-b/old-pinned-model";

    expect(aiModel()).toBe("vendor-b/old-pinned-model");
    expect(usingLegacyEnvNames()).toBe(true);
  });

  it("resolves the model per variable, so a partial rename still works", () => {
    // Canonical key and URL, but the model still under the old name: the
    // canonical variables must not switch off the legacy fallback for a
    // variable that was never migrated.
    process.env.AGENTFUND_AI_API_KEY = "k";
    process.env.AGENTFUND_AI_BASE_URL = "https://example.test/v1";
    process.env.AI_MODEL = "vendor-b/old-pinned-model";

    expect(aiModel()).toBe("vendor-b/old-pinned-model");
    expect(aiProviderConfigured()).toBe(true);
  });

  it("does not report legacy names once the canonical ones are used", () => {
    process.env.AGENTFUND_AI_API_KEY = "k";
    process.env.AGENTFUND_AI_BASE_URL = "https://example.test/v1";
    process.env.AGENTFUND_AI_MODEL = "vendor-a/model-one";

    expect(usingLegacyEnvNames()).toBe(false);
    expect(aiProviderConfigured()).toBe(true);
  });

  it("treats a blank AGENTFUND_AI_MODEL as unset rather than an empty model", () => {
    process.env.AGENTFUND_AI_MODEL = "   ";

    expect(aiModel()).toBeUndefined();
  });

  it("trims whitespace and newlines from values", () => {
    process.env.AGENTFUND_AI_MODEL = "  vendor-a/model-one\n";
    process.env.AGENTFUND_AI_BASE_URL = "https://example.test/v1//";
    process.env.AGENTFUND_AI_API_KEY = " secret-key \n";

    expect(aiModel()).toBe("vendor-a/model-one");
    // Trailing slashes are normalized so the endpoint cannot end up doubled.
    expect(aiBaseUrl()).toBe("https://example.test/v1");
    expect(aiProviderConfigured()).toBe(true);
  });

  it("gives the combined path one modest default cap", () => {
    // The normal path is a single call, so this governs latency. 4500, not
    // 48000: the historical cap let a model spend the whole budget thinking.
    expect(aiCombinedMaxTokens()).toBe(4500);
    expect(aiCombinedEnabled()).toBe(true);
    expect(aiTimeoutMs()).toBe(90000);
  });

  it("gives the fallback stages their own smaller caps", () => {
    expect(aiAnalysisMaxTokens()).toBe(1800);
    expect(aiPromptMaxTokens()).toBe(3000);
  });

  it("honours configured caps and timeout", () => {
    process.env.AGENTFUND_AI_MAX_TOKENS = "5000";
    process.env.AGENTFUND_AI_ANALYSIS_MAX_TOKENS = "1500";
    process.env.AGENTFUND_AI_PROMPT_MAX_TOKENS = "4000";
    process.env.AGENTFUND_AI_TIMEOUT_MS = "45000";

    expect(aiCombinedMaxTokens()).toBe(5000);
    expect(aiAnalysisMaxTokens()).toBe(1500);
    expect(aiPromptMaxTokens()).toBe(4000);
    expect(aiTimeoutMs()).toBe(45000);
  });

  it("never lets the deprecated AI_MAX_TOKENS raise any cap", () => {
    // The old variable was 48000 to work around a reasoning model. Honouring it
    // would restore one oversized cap for every call, so it must be ignored.
    process.env.AI_MAX_TOKENS = "48000";

    expect(aiCombinedMaxTokens()).toBe(4500);
    expect(aiAnalysisMaxTokens()).toBe(1800);
    expect(aiPromptMaxTokens()).toBe(3000);
    expect(legacyMaxTokensPresent()).toBe(true);
  });

  it("prefers the new caps when both old and new are set", () => {
    process.env.AI_MAX_TOKENS = "48000";
    process.env.AGENTFUND_AI_MAX_TOKENS = "4200";
    process.env.AGENTFUND_AI_ANALYSIS_MAX_TOKENS = "1600";
    process.env.AGENTFUND_AI_PROMPT_MAX_TOKENS = "3200";

    expect(aiCombinedMaxTokens()).toBe(4200);
    expect(aiAnalysisMaxTokens()).toBe(1600);
    expect(aiPromptMaxTokens()).toBe(3200);
  });

  it("can force the two-call path and report it", () => {
    process.env.AGENTFUND_AI_COMBINED = "0";
    expect(aiCombinedEnabled()).toBe(false);
    process.env.AGENTFUND_AI_COMBINED = "1";
    expect(aiCombinedEnabled()).toBe(true);
  });

  it("ignores non-positive or non-numeric limits instead of sending NaN", () => {
    process.env.AGENTFUND_AI_MAX_TOKENS = "0";
    process.env.AGENTFUND_AI_TIMEOUT_MS = "not-a-number";

    expect(aiCombinedMaxTokens()).toBe(4500);
    expect(aiTimeoutMs()).toBe(90000);
  });

  it("reads values on every call so a change takes effect without a restart", () => {
    process.env.AGENTFUND_AI_MODEL = "vendor-a/one";
    expect(aiModel()).toBe("vendor-a/one");

    process.env.AGENTFUND_AI_MODEL = "vendor-b/two";
    expect(aiModel()).toBe("vendor-b/two");
  });
});