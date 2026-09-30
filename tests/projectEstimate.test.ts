import { describe, expect, it } from "vitest";
import { estimateProjectImplementationCredit } from "@/lib/estimator/projectEstimate";
import { createInitialMemory, createProjectRecord } from "@/lib/projectMemory/intake";

describe("implementation CREDIT estimate", () => {
  it("stays explicitly separate from actual Promgent usage", () => {
    const project = createProjectRecord({ userId: "user", description: "Restaurant menu, reservations and contact website", modelId: "auto", planningDepth: "balanced", budget: 10 });
    const estimate = estimateProjectImplementationCredit(project, createInitialMemory(project));
    expect(estimate.kind).toBe("implementation_estimate");
    expect(estimate.estimated).toBe(true);
    expect(estimate.note).toContain("separate from Promgent's actual usage");
    expect(estimate.total.maximum).toBeGreaterThanOrEqual(estimate.total.minimum);
  });
});
