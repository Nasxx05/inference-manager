import { activeRequirements } from "@/lib/projectMemory/requirements";
import type { ProjectMemory } from "@/types/project";
import type { DataEntityDefinition, PageDefinition } from "@/types/technicalBlueprint";

const TECHNOLOGY_PATTERN = /\b(?:next(?:\.js)?|typescript|javascript|react|node(?:\.js)?|server actions?|route handlers?|api routes?|express|django|fastapi|python|java|spring|supabase|postgres(?:ql)?|mysql|mongodb|firebase|prisma|tailwind|vercel|aws|azure|gcp|docker|kubernetes|redis|graphql)\b/i;
const GENERIC_IMPLEMENTATION_PATTERN = /^(?:client|server|api|application|app|service|database|frontend|backend|web app|application api)$/i;

function key(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function unique(values: string[], limit = 20): string[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const normalized = key(value);
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [value.trim()];
  }).slice(0, limit);
}

function shortLabel(value: string, fallback: string): string {
  const words = value
    .replace(/[_/]+/g, " ")
    .replace(/[^a-zA-Z0-9 -]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, 4);
  return words.join(" ") || fallback;
}

function nodeId(prefix: string, label: string, index: number): string {
  const clean = label.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24);
  return `${prefix}_${clean || "ITEM"}_${index}`;
}

function featureLabel(description: string): string {
  const text = description.toLowerCase();
  if (/manage|confirm|approve|update/.test(text) && /reserv|book/.test(text)) return "Manage reservations";
  if (/reserv|book/.test(text)) return /cancel/.test(text) ? "Cancel reservation" : "Make reservation";
  if (/manage|publish|update/.test(text) && /menu/.test(text)) return "Manage menu";
  if (/menu/.test(text)) return "Browse menu";
  if (/place|create|submit/.test(text) && /order/.test(text)) return "Place order";
  if (/manage|view|fulfil|fulfill/.test(text) && /order/.test(text)) return "Manage orders";
  if (/review/.test(text)) return /manage|moderate/.test(text) ? "Manage reviews" : "Leave review";
  if (/contact|enquir|inquir|message/.test(text)) return "Send enquiry";
  if (/create|add/.test(text) && /task|to-?do/.test(text)) return "Add task";
  if (/complete|finish|done/.test(text) && /task|to-?do/.test(text)) return "Complete task";
  if (/edit|update|rename/.test(text) && /task|to-?do/.test(text)) return "Edit task";
  if (/delete|remove/.test(text) && /task|to-?do/.test(text)) return "Delete task";
  if (/filter|screen|criteria/.test(text) && /crypto|coin|token|asset/.test(text)) return "Filter assets";
  if (/compare/.test(text) && /crypto|coin|token|asset/.test(text)) return "Compare assets";
  if (/watchlist|favourite|favorite|save/.test(text) && /crypto|coin|token|asset/.test(text)) return "Manage watchlist";
  if (/alert|notification/.test(text) && /price|crypto|coin|token|asset/.test(text)) return "Set price alerts";
  if (/shorten|short link/.test(text)) return "Create short link";
  if (/click|analytic/.test(text)) return "View click totals";
  if (/sign.?in|log.?in/.test(text)) return "Sign in";
  const cleaned = description
    .replace(/^(?:the\s+)?(?:visitor|customer|user|member|administrator|admin|owner|staff|trader)s?\s+(?:can|must|should|may|will|needs? to)\s+/i, "")
    .replace(/^(?:the\s+)?(?:product|application|app|system)\s+(?:can|must|should|will|needs? to)\s+/i, "")
    .replace(/\b(?:a|an|the|their|its)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return shortLabel(cleaned, "Core feature");
}

function purposeDataLabel(name: string): string {
  const text = key(name);
  if (/reserv|book/.test(text)) return "Reservations data";
  if (/menu/.test(text)) return "Menu data";
  if (/order/.test(text)) return "Orders data";
  if (/review/.test(text)) return "Reviews data";
  if (/task|todo/.test(text)) return "Tasks data";
  if (/watchlist|favourite|favorite/.test(text)) return "Watchlist data";
  if (/profile|user|account/.test(text)) return "User profiles";
  if (/short link|link/.test(text)) return "Links data";
  if (/contact|message|enquir|inquir/.test(text)) return "Enquiries data";
  return `${shortLabel(name, "Product")} data`;
}

function purposeServiceLabel(name: string): string {
  const text = key(name);
  if (/payment|stripe|paypal|billing/.test(text)) return "Payment provider";
  if (/email|mail|notification|sms|twilio|sendgrid/.test(text)) return "Notification service";
  if (/crypto|coin|market|price|exchange/.test(text)) return "Market data API";
  if (/map|location|geocod/.test(text)) return "Location service";
  return `${shortLabel(name, "External")} service`;
}

function fallbackPages(memory: ProjectMemory, productText: string): PageDefinition[] {
  const pages: PageDefinition[] = [];
  if (/account|profile|sign.?in|log.?in|private|admin|role/.test(productText)) pages.push({ route: "/sign-in", name: "Sign in", purpose: "Enter a protected product area.", visibleContent: [], actions: ["Sign in"], dataNeeded: [] });
  if (/task|to-?do/.test(productText)) pages.push({ route: "/tasks", name: "Task dashboard", purpose: "Manage personal tasks.", visibleContent: [], actions: [], dataNeeded: ["Tasks"] });
  else if (/crypto|coin|token|screener/.test(productText)) pages.push({ route: "/markets", name: "Market dashboard", purpose: "Explore and compare market assets.", visibleContent: [], actions: [], dataNeeded: ["Market data"] });
  else if (/admin|owner|staff|manage/.test(productText)) pages.push({ route: "/admin", name: "Admin dashboard", purpose: "Manage product operations.", visibleContent: [], actions: [], dataNeeded: [] });
  else pages.push({ route: "/", name: "Main screen", purpose: memory.purpose, visibleContent: [], actions: [], dataNeeded: [] });
  return pages;
}

function inferredData(memory: ProjectMemory, productText: string): string[] {
  const values: string[] = [];
  if (/menu/.test(productText)) values.push("Menu data");
  if (/reserv|book/.test(productText)) values.push("Reservations data");
  if (/order/.test(productText)) values.push("Orders data");
  if (/review/.test(productText)) values.push("Reviews data");
  if (/task|to-?do/.test(productText)) values.push("Tasks data");
  if (/watchlist/.test(productText)) values.push("Watchlist data");
  if (/account|profile|sign.?in|log.?in/.test(productText)) values.push("User profiles");
  if (/shorten|short link/.test(productText)) values.push("Links data");
  if (/contact|enquir|inquir|message/.test(productText)) values.push("Enquiries data");
  return unique(values.length ? values : (memory.dataModel ?? []).map(purposeDataLabel), 3);
}

function pageForFeature(feature: string, pages: PageDefinition[]): number {
  const featureKey = key(feature);
  const preferred = pages.findIndex((page) => {
    const pageText = key(`${page.name} ${page.purpose} ${page.actions.join(" ")} ${page.dataNeeded.join(" ")}`);
    if (/admin|manage/.test(featureKey)) return /admin|manage/.test(pageText);
    if (/sign in/.test(featureKey)) return /sign in|account/.test(pageText);
    if (/menu/.test(featureKey)) return /menu/.test(pageText);
    if (/reserv|book/.test(featureKey)) return /reserv|book/.test(pageText);
    if (/order/.test(featureKey)) return /order|checkout/.test(pageText);
    if (/task/.test(featureKey)) return /task/.test(pageText);
    if (/asset|watchlist|price/.test(featureKey)) return /market|asset|watchlist/.test(pageText);
    return featureKey.split(" ").some((word) => word.length > 4 && pageText.includes(word));
  });
  return preferred >= 0 ? preferred : Math.max(0, pages.findIndex((page) => !/sign in|home/i.test(page.name)));
}

function dataForFeature(feature: string, data: string[]): number {
  const featureText = key(feature);
  const match = data.findIndex((item) => {
    const dataText = key(item);
    return featureText.split(" ").some((word) => word.length > 4 && dataText.includes(word))
      || (/task/.test(featureText) && /task/.test(dataText))
      || (/reserv|book/.test(featureText) && /reserv|book/.test(dataText))
      || (/menu/.test(featureText) && /menu/.test(dataText))
      || (/watchlist/.test(featureText) && /watchlist/.test(dataText));
  });
  return match >= 0 ? match : 0;
}

export function buildProductArchitecture(input: {
  memory: ProjectMemory;
  pages?: PageDefinition[];
  entities?: DataEntityDefinition[];
}): { summary: string; mermaid: string } {
  const supportedRequirements = activeRequirements(input.memory).filter((item) => item.source !== "system");
  const behavioralRequirements = supportedRequirements.filter((item) => item.type !== "business");
  const requirements = (behavioralRequirements.length ? behavioralRequirements : supportedRequirements).map((item) => item.description);
  const productText = key([input.memory.purpose, ...requirements, ...(input.memory.mvpScope ?? []), ...(input.memory.workflows ?? []), ...(input.memory.adminWorkflows ?? [])].join(" "));
  const suppliedPages = input.pages?.filter((page) => page.name && !/home/i.test(page.name)) ?? [];
  const pagePriority = (page: PageDefinition) => /sign in/i.test(page.name) ? 0 : /admin|manage/i.test(page.name) ? 1 : /dashboard|workspace/i.test(page.name) ? 2 : 3;
  const pages = (suppliedPages.length ? [...suppliedPages].sort((left, right) => pagePriority(left) - pagePriority(right)) : fallbackPages(input.memory, productText)).slice(0, 4);
  const roles = unique(input.memory.users.length ? input.memory.users : [/admin|owner|staff/.test(productText) ? "Administrator" : "User"], 3).map((item) => shortLabel(item, "User"));
  if (/admin|owner|staff/.test(productText) && !roles.some((role) => /admin|owner|staff/i.test(role))) roles.push("Administrator");

  const rawFeatures = unique([
    ...requirements,
    ...(input.memory.mvpScope ?? []),
    ...(input.memory.workflows ?? []),
    ...(input.memory.adminWorkflows ?? []),
    ...pages.flatMap((page) => page.actions.filter((action) => !/navigate|view an item|begin the primary/i.test(action))),
  ], 20);
  const features = unique(rawFeatures.map(featureLabel).filter((label) => !/core feature/i.test(label)), 7);
  const data = unique(input.entities?.length ? input.entities.map((item) => purposeDataLabel(item.name)) : inferredData(input.memory, productText), 3);
  const services = unique((input.memory.externalServices ?? []).map(purposeServiceLabel), 2);
  if (/crypto|coin|token|screener/.test(productText) && !services.includes("Market data API")) services.push("Market data API");
  if (/payment|checkout|billing/.test(productText) && !services.includes("Payment provider")) services.push("Payment provider");

  // Keep the map readable while preserving at least one role, one screen,
  // several real features, and the data/service boundary.
  const fixedCount = roles.length + pages.length + data.length + services.length;
  const visibleFeatures = features.slice(0, Math.max(2, 14 - fixedCount));
  const lines: string[] = ["flowchart LR"];
  const roleNodes = roles.map((label, index) => ({ id: nodeId("ROLE", label, index), label }));
  const pageNodes = pages.map((page, index) => ({ id: nodeId("SCREEN", page.name, index), label: shortLabel(page.name, "Main screen"), page }));
  const featureNodes = visibleFeatures.map((label, index) => ({ id: nodeId("FEATURE", label, index), label, pageIndex: pageForFeature(label, pages) }));
  const dataNodes = data.map((label, index) => ({ id: nodeId("DATA", label, index), label }));
  const serviceNodes = services.map((label, index) => ({ id: nodeId("SERVICE", label, index), label }));

  roleNodes.forEach((node) => lines.push(`${node.id}[${node.label}]`));
  pageNodes.forEach((node, pageIndex) => {
    lines.push(`subgraph AREA_${pageIndex}[${node.label} area]`, `  ${node.id}[${node.label}]`);
    featureNodes.filter((feature) => feature.pageIndex === pageIndex).forEach((feature) => lines.push(`  ${feature.id}[${feature.label}]`));
    lines.push("end");
  });
  dataNodes.forEach((node) => lines.push(`${node.id}[(${node.label})]`));
  serviceNodes.forEach((node) => lines.push(`${node.id}[${node.label}]`));

  const entryPageIndex = Math.max(0, pages.findIndex((page) => /sign in|home/i.test(page.name)));
  roleNodes.forEach((role) => {
    const adminPage = /admin|owner|staff/i.test(role.label) ? pages.findIndex((page) => /admin|manage/i.test(page.name)) : -1;
    lines.push(`${role.id} --> ${pageNodes[adminPage >= 0 ? adminPage : entryPageIndex]!.id}`);
  });
  if (/sign in|home/i.test(pages[entryPageIndex]?.name ?? "")) {
    pageNodes.forEach((page, index) => { if (index !== entryPageIndex) lines.push(`${pageNodes[entryPageIndex]!.id} --> ${page.id}`); });
  }
  featureNodes.forEach((feature) => {
    const page = pageNodes[feature.pageIndex] ?? pageNodes[0];
    if (page) lines.push(`${page.id} --> ${feature.id}`);
    const target = dataNodes[dataForFeature(feature.label, data)];
    if (target) lines.push(`${feature.id} --> ${target.id}`);
    const service = serviceNodes.find((item) => (/pay|checkout/.test(key(feature.label)) && /payment/.test(key(item.label))) || (/asset|price|market|crypto/.test(key(feature.label)) && /market data/.test(key(item.label))));
    if (service) lines.push(`${feature.id} --> ${service.id}`);
  });

  return {
    summary: `The product map shows how ${roles.join(" and ")} move through ${pages.map((page) => page.name).join(", ")} to use the confirmed features, and which product data or external services those features depend on. Technology choices are intentionally kept outside the diagram.`,
    mermaid: lines.slice(0, 80).join("\n"),
  };
}

function diagramNodes(source: string): Map<string, string> {
  const nodes = new Map<string, string>();
  const pattern = /\b([A-Za-z_][A-Za-z0-9_-]*)\s*(?:\[\(([^\]]+)\)\]|\[\[([^\]]+)\]\]|\[\{([^\]]+)\}\]|\[([^\]]+)\]|\(([^)]+)\)|\{([^}]+)\})/g;
  for (const match of source.matchAll(pattern)) {
    if (/^AREA_/.test(match[1] ?? "")) continue;
    const label = (match.slice(2).find(Boolean) ?? match[1] ?? "").replace(/["']/g, "").trim();
    if (match[1] && label) nodes.set(match[1], label);
  }
  return nodes;
}

export function validateProductArchitectureDiagram(source: string): {
  valid: boolean;
  reasons: string[];
  nodeCount: number;
  technologyNodeCount: number;
  straightChain: boolean;
} {
  const nodes = diagramNodes(source);
  const outgoing = new Map<string, number>();
  const incoming = new Map<string, number>();
  let edgeCount = 0;
  for (const line of source.split(/\r?\n/)) {
    const parts = line.trim().split(/\s*(?:-->|-\.->|==>)\s*/);
    if (parts.length < 2) continue;
    const from = parts[0]?.match(/^([A-Za-z_][A-Za-z0-9_-]*)/)?.[1];
    const to = parts[1]?.match(/^([A-Za-z_][A-Za-z0-9_-]*)/)?.[1];
    if (!from || !to) continue;
    edgeCount += 1;
    outgoing.set(from, (outgoing.get(from) ?? 0) + 1);
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
  }
  const labels = [...nodes.values()];
  const technologyNodeCount = labels.filter((label) => TECHNOLOGY_PATTERN.test(label)).length;
  const straightChain = nodes.size >= 4 && edgeCount >= nodes.size - 1
    && [...nodes.keys()].every((id) => (outgoing.get(id) ?? 0) <= 1 && (incoming.get(id) ?? 0) <= 1);
  const reasons: string[] = [];
  if (nodes.size < 6 || nodes.size > 14) reasons.push("Use 6 to 14 product boxes.");
  if (technologyNodeCount > nodes.size / 2) reasons.push("More than half of the boxes are technology names.");
  else if (technologyNodeCount > 0) reasons.push("Technology names must not be diagram boxes.");
  if (labels.some((label) => GENERIC_IMPLEMENTATION_PATTERN.test(label.trim()))) reasons.push("Generic implementation boxes must be replaced with real users, screens, features, data, or services.");
  if (straightChain) reasons.push("The diagram is a single straight chain instead of a branching product map.");
  return { valid: reasons.length === 0, reasons, nodeCount: nodes.size, technologyNodeCount, straightChain };
}
