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
  aiBaseUrl,
  aiMaxTokens,
  aiModel,
  aiProviderConfigured,
  aiTimeoutMs,
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

  it("uses the documented defaults for max tokens and timeout", () => {
    expect(aiMaxTokens()).toBe(8000);
    expect(aiTimeoutMs()).toBe(120000);
  });

  it("honours configured max tokens and timeout", () => {
    process.env.AGENTFUND_AI_MAX_TOKENS = "4000";
    process.env.AGENTFUND_AI_TIMEOUT_MS = "30000";

    expect(aiMaxTokens()).toBe(4000);
    expect(aiTimeoutMs()).toBe(30000);
  });

  it("ignores non-positive or non-numeric limits instead of sending NaN", () => {
    process.env.AGENTFUND_AI_MAX_TOKENS = "0";
    process.env.AGENTFUND_AI_TIMEOUT_MS = "not-a-number";

    expect(aiMaxTokens()).toBe(8000);
    expect(aiTimeoutMs()).toBe(120000);
  });

  it("reads values on every call so a change takes effect without a restart", () => {
    process.env.AGENTFUND_AI_MODEL = "vendor-a/one";
    expect(aiModel()).toBe("vendor-a/one");

    process.env.AGENTFUND_AI_MODEL = "vendor-b/two";
    expect(aiModel()).toBe("vendor-b/two");
  });
});