# Persisted identifier contract

This audit reflects migrations 001–005. Application code must generate a UUID only where a UUID primary key is supplied explicitly; otherwise the database default owns it. Domain/version identifiers remain text.

| Application field | Generated format / owner | Database column type |
|---|---|---|
| `projects.id` | RFC 4122 UUID, server `randomUUID()` | `uuid` |
| `orbio_connections.id` | database `gen_random_uuid()` | `uuid` |
| `interview_sessions.id` | RFC 4122 UUID, server `randomUUID()` | `uuid` |
| `interview_messages.id` | RFC 4122 UUID, shared `createUuid()` for turns and server `randomUUID()` for opening message | `uuid` |
| `project_references.id` | RFC 4122 UUID, server `randomUUID()` | `uuid` |
| `generated_prompts.id` | RFC 4122 UUID, server `randomUUID()` | `uuid` |
| `usage_events.id` | database `gen_random_uuid()` | `uuid` |
| `requirement_versions.id` | database `gen_random_uuid()` | `uuid` |
| `usage_snapshots.id` | database `gen_random_uuid()` | `uuid` |
| `github_repositories.id` / `repository_reviews.id` | database `gen_random_uuid()` | `uuid` |
| `repository_snapshots.id` / `live_product_snapshots.id` | database `gen_random_uuid()` | `uuid` |
| `suggestion_discussions.id` | RFC 4122 UUID, server `randomUUID()` | `uuid` |
| `requirements.id` / `acceptance_criteria.id` | deterministic domain identifier | `text` |
| `architecture_versions.id` / `srs_documents.id` | project ID + monotonic version | `text` |
| project iterations and iteration children | deterministic domain identifier | `text` |
| `screenshot_artifacts.id` | deterministic iteration artifact identifier | `text` |

`005_reliability_repairs.sql` casts both interview message IDs and the session ID to UUID inside the transaction. A malformed ID therefore fails the RPC and rolls back the entire turn.
