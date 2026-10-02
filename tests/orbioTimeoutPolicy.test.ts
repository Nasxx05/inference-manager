import { afterEach, describe, expect, it } from "vitest";
import { guidedInterviewTimeoutMs } from "../server/src/guidedInterview";
import { projectConversationTimeoutMs } from "../server/src/promgentConversation";

const originalInterview = process.env.ORBIO_INTERVIEW_TIMEOUT_MS;
const originalConversation = process.env.ORBIO_CONVERSATION_TIMEOUT_MS;

afterEach(() => {
  if (originalInterview === undefined) delete process.env.ORBIO_INTERVIEW_TIMEOUT_MS;
  else process.env.ORBIO_INTERVIEW_TIMEOUT_MS = originalInterview;
  if (originalConversation === undefined) delete process.env.ORBIO_CONVERSATION_TIMEOUT_MS;
  else process.env.ORBIO_CONVERSATION_TIMEOUT_MS = originalConversation;
});

describe("Orbio timeout policy", () => {
  it("gives detailed project discovery enough time to finish", () => {
    delete process.env.ORBIO_CONVERSATION_TIMEOUT_MS;
    expect(projectConversationTimeoutMs(["project_discovery"])).toBe(180_000);
    expect(projectConversationTimeoutMs(["architecture_request"])).toBe(150_000);
    expect(projectConversationTimeoutMs(["project_question"])).toBe(120_000);
  });

  it("gives guided interview turns a larger deadline than the old global default", () => {
    delete process.env.ORBIO_INTERVIEW_TIMEOUT_MS;
    expect(guidedInterviewTimeoutMs()).toBe(120_000);
  });

  it("honours bounded route-specific overrides", () => {
    process.env.ORBIO_CONVERSATION_TIMEOUT_MS = "210000";
    process.env.ORBIO_INTERVIEW_TIMEOUT_MS = "5000";
    expect(projectConversationTimeoutMs(["project_discovery"])).toBe(210_000);
    expect(guidedInterviewTimeoutMs()).toBe(30_000);
  });
});
