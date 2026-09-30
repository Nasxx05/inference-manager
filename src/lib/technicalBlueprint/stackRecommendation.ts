import type { ProjectMemory } from "@/types/project";
import type { RecommendedStack, StackChoice, StackStatus } from "@/types/technicalBlueprint";

function corpus(memory: ProjectMemory): string {
  return [memory.purpose, memory.projectType, ...memory.requirements.map((item) => item.description), ...(memory.constraints ?? []), ...memory.technicalConstraints, ...(memory.confirmedStack ?? []), ...(memory.proposedStack ?? []), memory.currentImplementationState ?? ""].join(" ").toLowerCase();
}

function choice(technology: string, purpose: string, rationale: string, status: StackStatus = "proposed", source: StackChoice["source"] = "promgent"): StackChoice {
  return { technology, purpose, rationale, status, source };
}

function explicit(memory: ProjectMemory): { values: string[]; status: StackStatus; source: StackChoice["source"] } | null {
  if (memory.confirmedStack?.length) return { values: memory.confirmedStack, status: "confirmed", source: "user" };
  if (memory.connectedRepository && memory.proposedStack?.length) return { values: memory.proposedStack, status: "existing", source: "repository" };
  if (memory.proposedStack?.length) return { values: memory.proposedStack, status: "proposed", source: "promgent" };
  return null;
}

function layer(value: string): keyof RecommendedStack {
  const item = value.toLowerCase();
  if (/tailwind|css|styled|material ui|chakra/.test(item)) return "styling";
  if (/postgres|mysql|sqlite|mongodb|database|supabase/.test(item) && !/auth/.test(item)) return "database";
  if (/auth|clerk|firebase authentication/.test(item)) return "authentication";
  if (/s3|storage|cloudinary/.test(item)) return "storage";
  if (/vercel|render|fly|railway|hosting|aws|azure|gcp/.test(item)) return "hosting";
  if (/vitest|jest|playwright|cypress|test/.test(item)) return "testing";
  if (/fastapi|django|express|nestjs|rails|laravel|server|backend/.test(item)) return "backend";
  return "frontend";
}

function fromExplicit(memory: ProjectMemory, selected: NonNullable<ReturnType<typeof explicit>>): RecommendedStack {
  const result: RecommendedStack = { additional: [] };
  for (const technology of selected.values) {
    const key = layer(technology);
    const value = choice(
      technology,
      `${String(key)} layer`,
      selected.status === "existing" ? "This technology is already established in the connected repository, so extending it avoids an unnecessary rewrite." : selected.status === "confirmed" ? "The user explicitly selected this technology." : "Promgent proposed this technology as a coherent fit for the current scope.",
      selected.status,
      selected.source,
    );
    if (key === "additional" || result[key]) result.additional.push(value);
    else Object.assign(result, { [key]: value });
  }
  return result;
}

export function recommendStack(memory: ProjectMemory): RecommendedStack {
  const selected = explicit(memory);
  if (selected) return fromExplicit(memory, selected);
  const text = corpus(memory);
  const mobile = /mobile app|ios|android|react native/.test(text);
  const python = /\bpython\b|django|fastapi/.test(text);
  const persistence = /book|reserv|account|profile|order|store|persist|history|admin|dashboard|request/.test(text);
  const accounts = /account|login|sign.?in|admin|role|protected|owner/.test(text);
  const files = /upload|image|photo|document|file|asset/.test(text);
  const realtime = /real.?time|live chat|presence|instant message/.test(text);
  const result: RecommendedStack = { additional: [] };

  if (mobile) {
    result.frontend = choice("Expo + React Native + TypeScript", "Cross-platform mobile client", "One TypeScript codebase can serve iOS and Android with a beginner-friendly managed build workflow.");
  } else {
    result.frontend = choice("Next.js + TypeScript", "Responsive web application", "It supports pages, server-rendered content, and server-side operations in one well-supported deployable application.");
    result.styling = choice("Tailwind CSS", "Responsive styling", "It keeps responsive and state styling close to components without introducing a separate design-system dependency.");
  }
  result.backend = python
    ? choice("FastAPI + Python", "Validated application API", "It respects the requested Python direction while providing typed request validation and straightforward API documentation.")
    : choice(mobile ? "Supabase Edge Functions / application services" : "Next.js Server Actions and Route Handlers", "Trusted server-side behavior", mobile ? "It keeps the first release on managed infrastructure and avoids operating a separate server." : "It keeps the client and server contract in one codebase and one deployment.");
  if (persistence) result.database = choice("Supabase PostgreSQL", "Persistent relational data", "The project has structured records and workflows; managed PostgreSQL provides constraints, transactions, and a clear upgrade path without custom database operations.");
  if (accounts) result.authentication = choice("Supabase Auth", "User sessions and protected access", "It integrates with the recommended database and avoids building password and session security from scratch.");
  if (files) result.storage = choice("Supabase Storage", "Private or public file storage", "It shares the same project and authorization model as the database and authentication layer.");
  result.hosting = choice(mobile ? "Expo Application Services" : python ? "Vercel for web + Render for API" : "Vercel", "Managed deployment", mobile ? "It provides managed mobile builds and releases." : python ? "Each runtime uses a simple managed platform suited to it." : "It is the simplest supported deployment path for Next.js with preview deployments and managed TLS.");
  result.testing = choice("Vitest + Testing Library + Playwright", "Unit, component, and critical journey testing", "These tools cover fast logic tests, UI behavior, and browser-level regression checks in the TypeScript ecosystem.");
  if (realtime) result.additional.push(choice("Supabase Realtime", "Live updates", "It can deliver the required live behavior without introducing a separate message broker."));
  return result;
}

export function stackChoices(stack: RecommendedStack): StackChoice[] {
  return [stack.frontend, stack.backend, stack.database, stack.authentication, stack.storage, stack.hosting, stack.styling, stack.testing, ...stack.additional].filter((item): item is StackChoice => Boolean(item));
}
