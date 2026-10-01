import { describe, expect, it } from "vitest";
import { routeOrbioModel, type OrbioCatalogueModel } from "@/lib/models/orbioRouter";
import { parseOrbioCatalogue } from "../server/src/orbioModelCatalogue";

const models: OrbioCatalogueModel[] = [
  { id: "provider/cheap-chat", contextLength: 128000, inputModalities: ["text"], outputModalities: ["text"], inputPricePerToken: 0.0000001, outputPricePerToken: 0.0000002 },
  { id: "deepseek/deepseek-v3", contextLength: 128000, inputModalities: ["text"], outputModalities: ["text"], inputPricePerToken: 0.0000003, outputPricePerToken: 0.000001 },
  { id: "google/gemini-3-pro", contextLength: 1000000, inputModalities: ["text", "image", "audio", "file"], outputModalities: ["text"], inputPricePerToken: 0.000002, outputPricePerToken: 0.00001 },
  { id: "openai/whisper-large-v3", contextLength: 32000, inputModalities: ["audio"], outputModalities: ["text"], inputPricePerToken: 0.0000075 },
];

describe("Orbio model router", () => {
  it("selects the lowest-cost adequate model rather than the cheapest model outright", () => {
    const route = routeOrbioModel({ models, mode: "auto", taskClass: "code_review", contextTokens: 40000 });
    expect(route.model.id).toBe("deepseek/deepseek-v3");
    expect(route.reasonCode).toBe("lowest_cost_adequate");
  });

  it("never routes an interactive turn to a cheaper batch-only alias", () => {
    const route = routeOrbioModel({
      models: [
        { id: "openai/gpt-6-luna:batch", contextLength: 128000, inputModalities: ["text"], outputModalities: ["text"], inputPricePerToken: 0.00000005, outputPricePerToken: 0.00000025 },
        { id: "openai/gpt-6-luna", contextLength: 128000, inputModalities: ["text"], outputModalities: ["text"], inputPricePerToken: 0.0000001, outputPricePerToken: 0.0000005 },
      ],
      mode: "auto",
      taskClass: "structured_project_update",
    });
    expect(route.model.id).toBe("openai/gpt-6-luna");
  });

  it("never routes a text interview to an image-only generator", () => {
    const route = routeOrbioModel({
      models: [
        { id: "qwen/qwen-image-3", contextLength: 65536, inputModalities: ["text", "image"], outputModalities: ["image"], inputPricePerToken: 0, outputPricePerToken: 0 },
        { id: "z-ai/glm-5.3-flash", contextLength: 1048576, inputModalities: ["text", "image"], outputModalities: ["text"], inputPricePerToken: 0.00000015, outputPricePerToken: 0.0000005 },
      ],
      mode: "auto",
      taskClass: "structured_project_update",
      contextTokens: 32000,
    });
    expect(route.model.id).toBe("z-ai/glm-5.3-flash");
  });

  it("filters by modality", () => {
    expect(routeOrbioModel({ models, mode: "auto", taskClass: "image_analysis", requiredModalities: ["text", "image"] }).model.id).toBe("google/gemini-3-pro");
    expect(routeOrbioModel({ models, mode: "auto", taskClass: "transcription", requiredModalities: ["audio"] }).model.id).toBe("openai/whisper-large-v3");
  });

  it("respects compatible locked models", () => {
    expect(routeOrbioModel({ models, mode: "locked", lockedModel: "google/gemini-3-pro", taskClass: "architecture" }).reasonCode).toBe("locked_model");
  });

  it("rejects an incompatible locked model without silently falling back", () => {
    expect(() => routeOrbioModel({ models, mode: "locked", lockedModel: "deepseek/deepseek-v3", taskClass: "image_analysis", requiredModalities: ["image"] })).toThrowError(expect.objectContaining({ code: "MODEL_INCOMPATIBLE" }));
  });

  it("parses provider metadata without treating it as a benchmark", () => {
    expect(parseOrbioCatalogue({ data: [{ id: "vendor/model", context_length: 64000, pricing: { prompt: "0.000001", completion: "0.000002" }, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } }] })).toEqual([{ id: "vendor/model", contextLength: 64000, inputModalities: ["text", "image"], outputModalities: ["text"], inputPricePerToken: 0.000001, outputPricePerToken: 0.000002 }]);
  });

  it("omits batch-only aliases from the interactive catalogue", () => {
    expect(parseOrbioCatalogue({ data: [
      { id: "openai/gpt-6-luna:batch", context_length: 128000, architecture: { input_modalities: ["text"] } },
      { id: "openai/gpt-6-luna", context_length: 128000, architecture: { input_modalities: ["text"] } },
    ] }).map((model) => model.id)).toEqual(["openai/gpt-6-luna"]);
  });
});
