# Promgent product architecture audit

Date: 2026-09-30
Branch audited: `main` at `91a6dbf`

This document is the required pre-implementation map for the conversation-first product refactor. It records the existing systems, their disposition, and the compatibility boundary before application code or deployed migrations are changed.

## Existing architecture

- Next.js 16/React 19 frontend with a single active entry point rendering `ProjectWorkspace` from the legacy `GuidedProjectWorkspace.tsx` file.
- Express backend mounted behind the frontend's same-origin `/backend` rewrite.
- Supabase Auth plus PostgREST persistence. The backend validates the user's session and uses server-only credentials for owned persistence operations.
- Encrypted, server-side Orbio credentials with connect-time verification, local hot-path decryption, safe fingerprints, metadata caching, and invalidation on provider authorization failures.
- A structured `ProjectMemory` domain with requirements, acceptance criteria, conflicts, assumptions, risks, questions, preferences, completeness, and versioning.
- Atomic PostgreSQL RPCs for project bootstrap, conversation/interview turns, lifecycle changes, and iteration change approval.
- Separate stage routes for interview, architecture, SRS, planning, and implementation iterations.
- Bounded public-GitHub inspection, exact commit capture, diff-aware indexing, secret redaction, untrusted-evidence boundaries, live-site inspection, screenshot analysis, traceability, and semantic review.
- Deterministic planning, estimation, scope optimization, prompt compilation, and a curated static model registry.
- 31 Vitest files plus GitHub Actions covering lint, audit, tests, frontend build, server typecheck, and server build.

## KEEP

These systems remain authoritative infrastructure and should be extended rather than rewritten:

- Supabase authentication, first-party session proxying, cookie/session renewal, ownership checks, and RLS policies.
- Credential encryption, stable encryption-key requirement, key fingerprints, backend-only decryption, and the Orbio inference hot path.
- Atomic persistence patterns and safe structured error logging with request references.
- `ProjectMemory` as canonical structured state; requirement provenance and confirmed/inferred distinctions.
- Requirement and acceptance-criterion validation, contradiction detection, question backlog, and deterministic completeness calculations as internal signals.
- Compact context construction that does not resend the full transcript.
- Reference/image byte validation, bounded processing, URL SSRF protection, redirect validation, and upload limits.
- Architecture generation's unchanged-version reuse behavior.
- Deterministic CREDIT estimator, planner, scope optimizer, and prompt compiler.
- Bounded repository inspection, exact SHA capture, changed-file prioritization, source redaction, and repository prompt-injection boundary.
- Review evidence, traceability, semantic validation, screenshot analysis, and diff-aware review domain logic.
- Usage ledger, safe performance measurements, provider timeouts, duplicate-charge safeguards, rate limits, and health endpoints.
- CI workflow and existing regression coverage.

## REFACTOR

- Expand `ProjectMemory` into the new canonical shape while preserving old JSON payloads through normalization defaults.
- Treat existing `interview_messages` as the compatibility source for project conversation while introducing generic message metadata and artifact references.
- Replace the requirements-interviewer prompt with one Promgent conversation response contract: natural message, validated memory changes, decisions, artifact requests, suggested actions, and next action.
- Generalize the current compact context builder into an intent-aware context composer using importance, relevance, and recency.
- Introduce a flexible intent router. It may emit multiple intents and must not require user selection.
- Add an Orbio catalogue/cache, curated capability registry, and server-side model router. Existing `selected_model` remains the locked-model value for legacy projects; new `model_mode` defaults to `auto`.
- Generalize architecture, SRS, generated prompts, and repository reviews behind a versioned artifact API while retaining their current tables as compatibility sources where useful.
- Move repository review and iteration operations into project conversation actions; retain the review engine and persisted iteration history underneath.
- Separate Promgent actual usage from deterministic external implementation estimates in both domain naming and UI.
- Split the 2,075-line workspace into focused conversation, sidebar, context, composer, artifact, project-list, auth, and settings components.
- Refactor transcription into a route resolver with a configured no-double-send fallback order and catalogue-informed diagnostics.
- Introduce `RepositoryTestRunner` and `BrowserTestRunner` contracts. The initial repository runner is disabled/static-CI evidence only unless isolated infrastructure is explicitly available.

## REPLACE

- Replace the stage-oriented primary workspace (`interview -> architecture -> SRS -> implementation -> iteration`) with a persistent chat-first project shell.
- Replace mandatory model and planning-depth intake fields with a simple idea composer, optional references, optional CREDIT budget, and default auto routing.
- Replace formal approval gates with readiness guidance and recorded assumptions. Advanced SRS approval may remain as artifact metadata, never as a conversational blocker.
- Replace percentage-first requirements progress with beginner-facing phases and a next recommended action.
- Replace separate full-screen architecture/SRS/implementation handoffs with inline, versioned artifact cards and optional detail views.
- Replace the current user-visible “Project CREDIT balance” conflation with Orbio balance, Promgent actual usage, and estimated build budget.
- Replace generic voice configuration with provider-capability routing and one selected billable request.

## REMOVE from active user paths

- “Guided Project,” “Requirements Interview,” named agent personalities, “SRS approval gate,” and “Iteration #X workspace” terminology.
- Mandatory beginner-facing model selection and planning-depth selection.
- Primary UX dependence on internal completeness percentages.
- Stage navigation that removes the conversation when viewing an artifact or reviewing implementation.
- The legacy standalone planner UI as the root product experience. Its deterministic engines remain reusable internally.
- Any implication that reading source means tests passed or runtime behavior was verified.

## Compatibility boundary

- Existing tables and migrations are immutable history. New changes use numbered migrations beginning with `010`.
- Existing projects must load without data rewrites. Legacy statuses map to conversational phases:
  - `intake` -> `exploring`
  - `interviewing`, `reviewing_requirements` -> `shaping`
  - `srs_ready`, `approved` -> `ready_to_build`
  - `implementation` -> `building`
  - `reviewing_repository` -> `reviewing`
  - `iterating` -> `improving`
  - `completed` -> `completed`
- Legacy `selected_model` is interpreted as locked only when `model_mode = locked`; legacy rows receive a compatibility default without breaking reads.
- Existing interview messages become project conversation messages through an adapter/backfill-safe view of the same history.
- Existing architecture, SRS, generated prompts, and repository reviews remain readable and can be materialized as artifacts without deleting their source rows.
- Existing Orbio credentials are never migrated to the browser or re-encrypted unnecessarily.

## Delivery order

1. Additive domain types, migration `010`, compatibility normalization, and contract tests.
2. Intent router, context composer, response validation, next-action engine, and atomic conversation service.
3. Live Orbio catalogue plus capability/cost/reliability routing and locked-model behavior.
4. Chat-first project shell and simplified project creation.
5. Artifact creation/versioning and inline artifact UI.
6. Separate actual usage and implementation estimates.
7. Conversation-integrated repository review and CI evidence.
8. Runner abstractions with execution disabled unless isolated infrastructure exists.
9. Full automated suite, builds, deployment, and evidence-based production validation.

## Known pre-refactor risks

- `GuidedProjectWorkspace.tsx`, `guidedRoutes.ts`, and `persistence.ts` are oversized and couple multiple domains.
- The stage gate makes conversational questions impossible outside the interview view.
- Guided inference and review currently reject `selectedModel = auto`, despite auto being a desired/default concept.
- The provider catalogue is fetched only during credential verification and is not an authoritative routing input.
- Transcription uses a single deployment-selected route; there is no capability resolver.
- There is no generic artifact store, decision ledger, model-route ledger, action/job record, CI evidence record, or test-run contract.
- Repository code is never executed—which is safe—but the product has no explicit runner abstraction or authorization record yet.
- No true browser E2E framework is installed; current UI coverage is component-level.
