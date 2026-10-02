import { normalizeProjectMemory } from "@/lib/projectMemory/compatibility";
import { activeRequirements } from "@/lib/projectMemory/requirements";
import { structuredAcceptanceCriteria } from "@/lib/projectMemory/proposals";
import type { ProjectMemory } from "@/types/project";
import type { ApiDefinition, DataEntityDefinition, ImplementationPhase, PageDefinition, TechnicalBlueprint, WorkflowDefinition } from "@/types/technicalBlueprint";
import { recommendStack, stackChoices } from "./stackRecommendation";

function unique(values: string[], limit = 30): string[] { return [...new Set(values.map((item) => item.trim()).filter(Boolean))].slice(0, limit); }
function contains(text: string, pattern: RegExp): boolean { return pattern.test(text); }
function id(value: string): string { return value.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 28) || "COMPONENT"; }
function semantic(value: TechnicalBlueprint): string { const { generatedAt: _generatedAt, memoryVersion: _memoryVersion, version: _version, ...rest } = value; return JSON.stringify(rest); }

function deriveWorkflows(memory: ProjectMemory, requirements: string[]): WorkflowDefinition[] {
  const supplied = unique([...(memory.workflows ?? []), ...(memory.adminWorkflows ?? [])], 12);
  const values = supplied.length ? supplied : requirements.filter((item) => /book|reserv|contact|request|order|register|login|upload|manage|create|search/i.test(item)).slice(0, 8);
  return values.map((value, index) => {
    const admin = /admin|owner|staff|manage|confirm|approve/i.test(value) || index >= (memory.workflows?.length ?? values.length);
    return {
      name: value.replace(/[.!]$/, ""),
      actor: admin ? "Administrator" : memory.users[0] ?? "User",
      steps: [
        `The ${admin ? "administrator" : "user"} opens the relevant interface.`,
        `The application presents the information and controls needed to ${value.toLowerCase()}.`,
        "The server validates the request and verifies authorization where required.",
        "The system persists the valid change and returns an explicit success result.",
      ],
      failureBehavior: ["Keep entered data where safe, explain the failure plainly, and allow a retry without creating duplicates."],
    };
  });
}

function derivePages(memory: ProjectMemory, text: string): PageDefinition[] {
  const pages: PageDefinition[] = [{ route: "/", name: "Home", purpose: "Explain the product or service and direct users to the primary action.", visibleContent: [memory.purpose || "Project value proposition", "Primary navigation", "Primary call to action"], actions: ["Navigate to the main workflow"], dataNeeded: ["Published public content"] }];
  if (/service|menu|product|listing|catalog/i.test(text)) pages.push({ route: /menu/i.test(text) ? "/menu" : "/services", name: /menu/i.test(text) ? "Menu" : "Services", purpose: "Show the available offering clearly.", visibleContent: ["Available items", "Descriptions", "Relevant price or detail information"], actions: ["View an item", "Begin the primary request"], dataNeeded: ["Published offering records"] });
  if (/book|reserv|appointment|request date/i.test(text)) pages.push({ route: "/booking", name: "Booking request", purpose: "Collect a valid date or appointment request.", visibleContent: ["Availability guidance", "Request form", "Confirmation state"], actions: ["Submit a booking request"], dataNeeded: ["Service options", "Existing availability rules"] });
  if (/contact|message|enquiry|inquiry/i.test(text)) pages.push({ route: "/contact", name: "Contact", purpose: "Let a visitor send a structured enquiry.", visibleContent: ["Contact details", "Contact form"], actions: ["Send an enquiry"], dataNeeded: ["Public contact information"] });
  if (/account|login|sign.?in/i.test(text)) pages.push({ route: "/sign-in", name: "Sign in", purpose: "Create or resume an authenticated session.", visibleContent: ["Credential form", "Recovery link", "Validation feedback"], actions: ["Sign in", "Request password recovery"], dataNeeded: [] });
  if (/admin|owner|staff|manage|confirm/i.test(text)) pages.push({ route: "/admin", name: "Administration", purpose: "Let authorized staff manage operational records.", visibleContent: ["Pending work", "Status and filters", "Record details"], actions: ["Review", "Confirm or update status"], dataNeeded: ["Authorized operational records"] });
  return pages.slice(0, 12);
}

function entity(name: string, purpose: string, fields: DataEntityDefinition["fields"], relationships: string[] = []): DataEntityDefinition {
  return { name, purpose, fields, relationships, constraints: ["Use a stable primary key.", "Record creation and update timestamps."] };
}

function field(name: string): DataEntityDefinition["fields"][number] {
  const clean = name.trim().replace(/[^a-zA-Z0-9_ ]/g, "").replace(/\s+/g, "_").toLowerCase();
  const type = /(?:^|_)id$/.test(clean) ? "uuid" : /(?:_at|date|time)$/.test(clean) ? "timestamptz" : /^(?:is_|has_)/.test(clean) ? "boolean" : /(?:count|amount|price|total)$/.test(clean) ? "numeric" : "text";
  return { name: clean || "value", type, required: true, constraints: clean === "id" ? ["Stable primary key"] : ["Validate and length-limit on the server"] };
}

function deriveEntities(memory: ProjectMemory, text: string): DataEntityDefinition[] {
  const entities: DataEntityDefinition[] = [];
  if (/account|profile|login|admin|user/i.test(text)) entities.push(entity("profiles", "Application identity and role data linked to authentication.", [{ name: "id", type: "uuid", required: true, constraints: ["References the authenticated user"] }, { name: "role", type: "text", required: true, constraints: ["Allow only defined roles"] }, { name: "display_name", type: "text", required: true, constraints: ["Trim and length-limit"] }]));
  if (/service|menu|product|listing|catalog/i.test(text)) entities.push(entity(/menu/i.test(text) ? "menu_items" : /product|listing/i.test(text) ? "listings" : "services", "Published items shown to users.", [{ name: "id", type: "uuid", required: true, constraints: [] }, { name: "name", type: "text", required: true, constraints: ["Non-empty"] }, { name: "description", type: "text", required: true, constraints: ["Length-limited"] }, { name: "is_published", type: "boolean", required: true, constraints: ["Defaults to false"] }]));
  if (/book|reserv|appointment|request date/i.test(text)) entities.push(entity(/reserv/i.test(text) ? "reservations" : "booking_requests", "A customer's requested date and its operational status.", [{ name: "id", type: "uuid", required: true, constraints: [] }, { name: "customer_name", type: "text", required: true, constraints: ["Trim and length-limit"] }, { name: "customer_email", type: "text", required: true, constraints: ["Normalize and validate"] }, { name: "requested_at", type: "timestamptz", required: true, constraints: ["Must satisfy booking rules"] }, { name: "status", type: "text", required: true, constraints: ["pending, confirmed, declined, cancelled"] }], ["Optionally belongs to a profile or service"]));
  if (/contact|message|enquiry|inquiry/i.test(text)) entities.push(entity("contact_requests", "A visitor enquiry and its processing status.", [{ name: "id", type: "uuid", required: true, constraints: [] }, { name: "name", type: "text", required: true, constraints: ["Trim and length-limit"] }, { name: "email", type: "text", required: true, constraints: ["Normalize and validate"] }, { name: "message", type: "text", required: true, constraints: ["Length-limit"] }, { name: "status", type: "text", required: true, constraints: ["Defaults to new"] }]));
  for (const description of memory.dataModel ?? []) {
    const [rawName, rawFields = ""] = description.split(/:\s*/, 2);
    const name = rawName?.trim().replace(/\b(?:record|entity|table)\b/gi, "").replace(/[^a-zA-Z0-9 ]/g, " ").trim().replace(/\s+/g, "_").toLowerCase();
    if (!name || name.length > 48 || entities.some((item) => item.name === name)) continue;
    const parsedFields = rawFields.split(/[,|]/).map(field).filter((item) => item.name).slice(0, 12);
    entities.push(entity(name, `Persistent ${rawName.trim()} state required by the described user workflows.`, parsedFields.length ? parsedFields : [field("id"), field("status"), field("created_at")]));
  }
  return entities.slice(0, 12);
}

function deriveApi(memory: ProjectMemory, pages: PageDefinition[], accounts: boolean): ApiDefinition[] {
  const inferred = pages.flatMap((page) => page.actions.filter((action) => /submit|send|review|confirm|update|sign in/i.test(action)).map((action) => ({ name: action, method: /view|review/i.test(action) ? "GET" : "POST", authentication: /admin|review|confirm|update/i.test(`${page.name} ${action}`) ? "Authenticated administrator role" : accounts && /sign in/i.test(action) ? "Public authentication operation" : "Public with abuse controls", request: ["Only fields required by the operation"], validation: ["Validate types, lengths, allowed values, and business rules on the server"], response: "Return a typed success result or a safe field-level/domain error without leaking internals." })));
  const explicit = (memory.apis ?? []).map((description) => {
    const match = description.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s]*)/i);
    return {
      name: description,
      method: match?.[1]?.toUpperCase() ?? (/read|list|view|fetch|get/i.test(description) ? "GET" : "POST"),
      ...(match?.[2] ? { path: match[2] } : {}),
      authentication: /admin|owner|private|protected/i.test(description) ? "Authenticated authorized role" : "Derive from the owning workflow; default to least privilege",
      request: ["Only the fields required for this operation"],
      validation: ["Validate identity, authorization, types, limits, allowed values, and domain rules on the server"],
      response: "Return a typed success result or a safe actionable error; make retryable writes idempotent where needed.",
    };
  });
  return [...explicit, ...inferred].filter((item, index, values) => values.findIndex((candidate) => candidate.name.toLowerCase() === item.name.toLowerCase()) === index).slice(0, 24);
}

function architecture(memory: ProjectMemory, stack: ReturnType<typeof recommendStack>, entities: DataEntityDefinition[]) {
  const choices = stackChoices(stack);
  const frontend = stack.frontend?.technology ?? "Web Client";
  const backend = stack.backend?.technology ?? "Application Server";
  const database = stack.database?.technology;
  const lines = ["flowchart TD", `USER[${memory.users[0] ?? "User"}] --> CLIENT[${frontend}]`, `CLIENT --> SERVER[${backend}]`];
  if ((memory.adminWorkflows?.length ?? 0) > 0) lines.push("ADMIN[Administrator] --> CLIENT");
  if (stack.authentication) lines.push(`CLIENT --> AUTH[${stack.authentication.technology}]`, "SERVER --> AUTH");
  if (entities.length) lines.push("SERVER --> DOMAIN[Domain workflows and validation]");
  if (database) lines.push(`${entities.length ? "DOMAIN" : "SERVER"} --> DB[(${database})]`);
  if (stack.storage) lines.push(`SERVER --> STORAGE[${stack.storage.technology}]`);
  for (const service of memory.externalServices ?? []) lines.push(`SERVER --> ${id(service)}[${service}]`);
  entities.slice(0, 6).forEach((item) => { if (database) lines.push(`DB --> ${id(item.name)}[${item.name.replaceAll("_", " ")}]`); });
  return { summary: `The ${frontend} handles user interaction and delegates trusted operations to ${backend}${database ? `, which persists structured state in ${database}` : ""}. ${choices.filter((item) => item.status === "proposed").length ? "The technologies are Promgent recommendations until the user confirms them." : "The stack reflects confirmed or existing technical direction."}`, mermaid: unique(lines, 30).join("\n") };
}

function phases(pages: PageDefinition[], entities: DataEntityDefinition[]): ImplementationPhase[] {
  return [
    { name: "Phase 1 — Foundation", objective: "Establish the project, shared UI foundation, configuration, and data contracts.", deliverables: ["Project structure", "Environment validation", "Shared layout and error boundaries"], dependsOn: [] },
    { name: "Phase 2 — Core data and server behavior", objective: "Implement persistent entities and validated server operations.", deliverables: entities.length ? entities.map((item) => `${item.name} schema and operations`) : ["Required server operations"], dependsOn: ["Phase 1 — Foundation"] },
    { name: "Phase 3 — User workflows", objective: "Build the complete primary and administrative journeys.", deliverables: pages.map((page) => `${page.name} screen`).slice(0, 10), dependsOn: ["Phase 2 — Core data and server behavior"] },
    { name: "Phase 4 — Quality and security", objective: "Close validation, authorization, accessibility, responsive, and regression gaps.", deliverables: ["Automated tests", "Accessibility review", "Security checks", "Responsive verification"], dependsOn: ["Phase 3 — User workflows"] },
    { name: "Phase 5 — Deployment", objective: "Configure production safely and verify the deployed critical journey.", deliverables: ["Production environment", "Migration execution", "Smoke-test evidence"], dependsOn: ["Phase 4 — Quality and security"] },
  ];
}

export function buildTechnicalBlueprint(input: { memory: ProjectMemory; previous?: TechnicalBlueprint; repositoryEvidence?: { url: string; commitSha?: string; existingStack?: string[]; relevantFiles?: string[] }; now?: string }): TechnicalBlueprint {
  const memory = normalizeProjectMemory(input.memory);
  const active = activeRequirements(memory);
  const requirementText = active.map((item) => item.description);
  const text = [memory.purpose, ...requirementText, ...(memory.mvpScope ?? []), ...(memory.workflows ?? [])].join(" ");
  if (input.repositoryEvidence) memory.connectedRepository = input.repositoryEvidence.url;
  if (input.repositoryEvidence?.existingStack?.length && !memory.confirmedStack?.length) memory.proposedStack = input.repositoryEvidence.existingStack;
  const stack = recommendStack(memory);
  const mvpScope = unique(memory.mvpScope?.length ? memory.mvpScope : active.filter((item) => item.required).map((item) => item.description), 30);
  const entities = deriveEntities(memory, text);
  const pages = derivePages(memory, text);
  const workflows = deriveWorkflows(memory, requirementText);
  const accounts = /account|login|admin|role|protected/i.test(text);
  const qualityWarnings = [!memory.purpose ? "The product objective is not yet explicit." : "", !memory.users.length ? "Primary users are inferred and should be confirmed." : "", !mvpScope.length ? "MVP scope is not yet defined." : ""].filter(Boolean);
  const candidate: TechnicalBlueprint = {
    projectId: memory.projectId,
    version: input.previous?.version ?? 1,
    memoryVersion: memory.version,
    objective: memory.purpose || "Implement the currently confirmed project requirements.",
    targetUsers: unique(memory.users.length ? memory.users : ["Primary user", ...(accounts ? ["Administrator"] : [])]),
    mvpScope,
    excludedScope: unique([...(memory.deferredScope ?? []), ...(memory.rejectedIdeas ?? [])]),
    recommendedStack: stack,
    systemComponents: [
      ...stackChoices(stack).map((item) => ({ id: id(item.purpose), name: item.purpose, responsibility: item.rationale, technology: item.technology, communicatesWith: [] })),
      ...(entities.length ? [{ id: "DOMAIN_WORKFLOWS", name: "Domain workflows", responsibility: `Validate and coordinate ${workflows.map((item) => item.name).slice(0, 5).join(", ") || "the primary product workflows"} without leaving partial state.`, communicatesWith: [stack.backend?.technology ?? "Application server", stack.database?.technology ?? "Persistent storage"] }] : []),
    ],
    workflows,
    pages,
    dataEntities: entities,
    apiSurface: deriveApi(memory, pages, accounts),
    security: [
      { area: "Server validation", behavior: "Validate all untrusted input on the server; browser validation is usability support only.", rationale: "Client input can be bypassed." },
      ...(accounts ? [{ area: "Authorization", behavior: "Verify the authenticated identity and required role on every protected server operation and database policy.", rationale: "Hiding controls in the UI is not authorization." }] : []),
      { area: "Secrets", behavior: "Keep credentials in server-side environment variables and never expose values in client bundles, prompts, or logs.", rationale: "Credentials grant access to external systems and data." },
      ...(contains(text, /contact|book|reserv|request|form/i) ? [{ area: "Abuse prevention", behavior: "Rate-limit public submissions and return generic failure messages while logging safe request identifiers.", rationale: "Public forms are an abuse and spam boundary." }] : []),
    ],
    integrations: (memory.externalServices ?? []).map((name) => ({ name, purpose: `Support the ${name} integration required by the project.`, direction: "Server to external service", failureBehavior: "Use bounded timeouts, safe errors, and idempotency where the operation can be repeated." })),
    nonFunctionalRequirements: active.filter((item) => item.type === "non_functional" || ["security", "performance", "accessibility"].includes(item.category)).map((item) => item.description),
    implementationPhases: phases(pages, entities),
    testingStrategy: { unit: ["Validation, authorization, state transitions, and deterministic domain logic"], integration: ["Database constraints, authenticated operations, and external-service adapters"], endToEnd: workflows.slice(0, 6).map((item) => item.name), regression: ["Existing working routes and persisted records", "Failed submissions do not create partial or duplicate state"] },
    deploymentPlan: { platform: stack.hosting?.technology ?? "Use the repository's established platform", steps: ["Validate environment configuration", "Apply additive database migrations", "Build and test the production artifact", "Deploy and run critical-journey smoke tests"], environmentVariables: unique([...(stack.database ? ["DATABASE_URL or managed database project variables"] : []), ...(stack.authentication ? ["Authentication provider URL and public/server keys"] : []), ...(memory.externalServices ?? []).map((item) => `${id(item)}_API_KEY`)]), releaseChecks: ["Production build succeeds", "Migrations are applied", "Authentication and critical write/read journey succeeds", "No secret appears in browser output or logs"] },
    architecture: architecture(memory, stack, entities),
    assumptions: unique([...memory.assumptions, ...qualityWarnings.map((warning) => `Assumption: ${warning}`)]),
    risks: unique(memory.risks),
    acceptanceCriteria: structuredAcceptanceCriteria(memory).filter((item) => item.status !== "rejected" && item.status !== "superseded").map((item) => item.description),
    ...(input.repositoryEvidence ? { repository: { url: input.repositoryEvidence.url, ...(input.repositoryEvidence.commitSha ? { reviewedCommit: input.repositoryEvidence.commitSha } : {}), existingStack: input.repositoryEvidence.existingStack ?? [], relevantFiles: input.repositoryEvidence.relevantFiles?.slice(0, 30) ?? [] } } : {}),
    quality: qualityWarnings.length ? "incomplete" : "ready",
    qualityWarnings,
    generatedAt: input.now ?? new Date().toISOString(),
  };
  if (input.previous && semantic(input.previous) === semantic(candidate)) return input.previous;
  return { ...candidate, version: input.previous ? input.previous.version + 1 : 1 };
}

export function parseTechnicalBlueprint(value: unknown): TechnicalBlueprint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<TechnicalBlueprint>;
  if (!candidate.projectId || !candidate.objective || !candidate.architecture?.mermaid || !candidate.recommendedStack || !Array.isArray(candidate.mvpScope) || !Array.isArray(candidate.workflows) || !Array.isArray(candidate.implementationPhases)) return undefined;
  if (!Number.isInteger(candidate.version) || !Number.isInteger(candidate.memoryVersion)) return undefined;
  return candidate as TechnicalBlueprint;
}
