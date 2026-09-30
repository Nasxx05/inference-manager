import type { OrbioCatalogueModel, RequiredModality } from "@/lib/models/orbioRouter";

interface ProviderModel { id?: unknown; context_length?: unknown; pricing?: Record<string, unknown>; architecture?: { input_modalities?: unknown; output_modalities?: unknown }; }
const CACHE_MS = 10 * 60_000;
let cache: { models: OrbioCatalogueModel[]; fetchedAt: number } | null = null;

function baseUrl(): string { return String(process.env.ORBIO_BASE_URL ?? process.env.AGENTFUND_AI_BASE_URL ?? "https://api.orbio.so/api/v1").trim().replace(/\/+$/, ""); }
function modalities(value: unknown): RequiredModality[] { return Array.isArray(value) ? value.filter((item): item is RequiredModality => ["text", "image", "audio", "file"].includes(String(item))) : ["text"]; }
function price(value: unknown): number | undefined { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined; }

export function parseOrbioCatalogue(payload: unknown): OrbioCatalogueModel[] {
  const data = payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data) ? (payload as { data: ProviderModel[] }).data : [];
  return data.flatMap((item) => {
    const id = String(item.id ?? "").trim(); if (!id) return [];
    const input = price(item.pricing?.prompt); const output = price(item.pricing?.completion);
    return [{ id, contextLength: Math.max(1, Number(item.context_length ?? 0) || 32_000), inputModalities: modalities(item.architecture?.input_modalities), outputModalities: Array.isArray(item.architecture?.output_modalities) ? item.architecture!.output_modalities!.map(String) : ["text"], ...(input !== undefined ? { inputPricePerToken: input } : {}), ...(output !== undefined ? { outputPricePerToken: output } : {}) }];
  });
}

export function cachedOrbioCatalogue(): OrbioCatalogueModel[] { return cache ? [...cache.models] : []; }

export async function refreshOrbioCatalogue(force = false): Promise<OrbioCatalogueModel[]> {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_MS) return [...cache.models];
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${baseUrl()}/models`, { headers: { Accept: "application/json" }, signal: controller.signal });
    if (!response.ok) throw new Error(`catalogue ${response.status}`);
    const models = parseOrbioCatalogue(await response.json());
    if (!models.length) throw new Error("empty catalogue");
    cache = { models, fetchedAt: Date.now() };
    return [...models];
  } finally { clearTimeout(timer); }
}

export function warmOrbioCatalogue(): void {
  void refreshOrbioCatalogue().catch((error) => console.warn("[orbio-catalogue] refresh failed", error instanceof Error ? error.message : "unknown"));
}
