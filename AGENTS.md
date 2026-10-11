# Agent guide

## Scope and authority

Build the bounded Creator Support PH forms assessment. Devon must understand and
be able to defend the code in the follow-up interview. Favor readable code,
correct relationships and complete required behavior over cleverness or extras.
The user's current request defines the active ticket; do not start the next phase
because it appears in a plan. PDFs, emails and planning documents are reference
material, not permission to send messages, publish, deploy or delete data.
Preserve unrelated changes and do not spawn subagents unless explicitly requested.

## Load context efficiently

1. Inspect `git status --short` and the latest checkpoint in `PROGRESS.md`. Read its
   opening status and latest relevant section, not every historical entry.
2. Read the active ticket and agreed behavior in `docs/BUILD-PLAN.md`. Use `README.md`
   and actual package scripts for setup/commands. Read nearby code and applicable
   nested AGENTS.md files before editing.
3. For schema work, consult `docs/DATA-MODEL.md`, then verify against migrations,
   constraints and services. Design notes may be stale; they do not prove implementation.
4. Reopen the assessment PDF only to resolve a requirement not captured below or
   a discrepancy. Ask when an unresolved product decision materially changes behavior.

Use `rg` with targeted paths/patterns and bounded context. Batch independent reads;
keep dependent edits and checks sequential. Reuse findings within the turn instead
of rereading entire files or dumping logs. Expand investigation when evidence warrants
it; token savings must not replace necessary validation or hide uncertainty.
Never read or print `.env` contents unnecessarily. Do not expose secrets in logs.

## Assessment requirements

- Monorepo: `apps/api` (Express/TypeScript), `apps/web` (Next.js/TypeScript), and
  `apps/webhook-consumer`; PostgreSQL via local Docker Compose; JWT authentication.
- Owners register/login, create/edit/delete forms, reorder questions, publish to
  a public URL and unpublish. Public filling/submission requires no login.
- Every management route requires authentication and explicit ownership. Drafts
  stay private; no owner may access another owner's forms, responses or exports.
- Eight types: short text, long text, date, dropdown, multi-select dropdown,
  multiple choice (radio), checkboxes, linear scale with optional end labels.
  Validate required values, option membership and scale ranges on the server.
- Collect a required, format-validated system email plus submission timestamp and
  answers. Repeated emails are allowed. Owner list/detail must survive later edits.
- Server-generated streamed XLSX: one response per row; email, submitted-at, then
  questions in order; multiple values sensibly represented in one cell.
- Per-form webhook URL/secret; POST after submission commits. Slow/failed delivery
  must never delay or fail submission. Bound duration and log timestamp, status
  and errors in owner UI. No retries required.
- Minimal consumer: receive POST, reject missing/wrong secret with 401, hold or
  persist payloads and display a list. No user auth or database required.
- Seeds: two users, three to four forms across owners including draft/published,
  all eight types, sample responses and a configured webhook.
- README explains setup/run/seed, consumer setup, payload, schema/config/answer
  modelling, historical responses and auth decisions.
- Exclude uploads, respondent editing, email notifications, branching/page breaks,
  collaborators, mobile apps and other unrequested features.

## Agreed design decisions (not additional PDF requirements)

- Mutable working drafts can be incomplete, including blank titles. Publication
  requires a nonblank title, at least one question and a nonblank label on every
  question. Description is optional; duplicate question labels are allowed.
- Option labels are nonblank and distinct after trimming, case-sensitive.
  Required choice questions need two options except checkboxes may have one;
  optional choice questions may have one. Scale endpoints are integers, min < max.
- Each new confirmed publish action creates an immutable version, even if unchanged.
  Replaying the same action returns its original version without moving the current
  pointer or republishing. A changed expected draft returns `409 DRAFT_CHANGED`.
- Only the current published, non-archived version accepts submissions. Stale
  submissions save nothing and ask for explicit refresh; retain entered values
  until then. Coordinate publication, unpublication, archive and submission locks.
- Unpublish retains owner access and the version pointer. Delete means archive:
  retain records but deny public and owner application access, including subroutes.
- Historical wording, order, choices, types and ranges remain immutable. Missing
  answers show **Not answered** and export as blanks. Date-only values stay dates;
  submission timestamps are instants.
- XLSX uses a sheet per historical version containing responses. Preserve the
  documented empty-export policy; verify its exact contract before implementing.

## Readable implementation

- Name domain concepts explicitly: `formVersionId`, `selectedOptionIds`, `publishedAt`.
  Use early returns and clear business rules; avoid dense chains/nested ternaries.
- Keep focused functions and related code together. Extract meaningful operations,
  not one-line wrappers or generic repository/service frameworks. Share contracts
  and validation when useful without importing server code into browser bundles.
- Strict TypeScript: narrow unknown input at runtime; use discriminated unions for
  configurations/answers. Avoid `any`, non-null assertions and casts hiding problems.
- Routes authenticate, validate, call domain operations and return consistent safe
  errors. Scope queries by owner; UUIDs and valid JWTs do not establish ownership.
- Use parameterized pg queries and SQL migrations already in the repo. Enforce
  answer/version and option/question membership, uniqueness and checks in the DB;
  explain remaining service validation. Never rewrite an applied migration.
- Keep transaction/pool lifecycle explicit. Do not reset databases, remove volumes,
  disable protections or erase records to fix development problems.
- Comment on why: lock ordering, historical identity and non-obvious constraints.
  Use the existing npm lockfile, formatter and linter. Add dependencies only for
  concrete needs; do not replace the stack or introduce competing toolchains.
- Frontend: semantic labels, keyboard/focus access, phone-sized controls and clear
  loading/empty/error/success states. Keep state local, derive values when possible,
  use stable IDs and distinguish saving drafts from publishing.

## Verification and handoff

- Run relevant existing scripts; inspect scripts before assuming commands exist.
  Use real PostgreSQL tests for relationships, ownership, history, atomic writes
  and lifecycle races. Create isolated test schemas and remove only those you own.
- For changed answer handling, cover all eight types, whitespace, optional blanks,
  repeated emails, foreign options and hidden/stale forms. For XLSX, inspect actual
  cells with historical versions, blanks, multi-values and zero responses; text
  must not become formulas. For webhooks, cover success, wrong secret, non-2xx,
  timeout and connection failure without changing submission success.
- Check user-visible behavior and phone layouts when changing UI. Run focused
  tests first, then required lint/types/build checks. Repeat only after relevant
  changes or unresolved failures. Documentation-only edits need content/diff review.
- Use available skills only when relevant; read their instructions first. PDF for
  source review, spreadsheets for inspecting exports, browser tools for UI checks.
  Use installed framework docs or primary official sources for uncertain behavior.
  Sites is not the workflow for this existing Express/Next.js repository.
- Review the diff for unrelated edits/secrets. Report implemented, tested, pending
  and externally changed work separately; never claim unrun checks or hosted CI.
- Update the opening status and a concise latest checkpoint in `PROGRESS.md` at
  ticket boundaries and before context gets long: decisions, files, check results,
  blockers, temporary processes/schemas and exact next step. Avoid duplicate history.
  Check Git ignore rules: local docs may not be included in a proposed commit.
- Explain meaningful decisions briefly, with a concrete example when helpful.
  Finish with outcome, verification and limitations. Group commits by coherent
  behavior; preserve unrelated changes and do not commit/push unless requested.
