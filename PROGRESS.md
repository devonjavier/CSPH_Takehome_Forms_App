# Project handoff and progress checkpoint

Last updated: October 9, 2026 (Asia/Manila).
Current instruction: APP-01 acceptance checks completed; await the next ticket.
ISP interruptions make this file the durable restart point.
Read AGENTS.md and inspect actual files/status before resuming. Update this file at
phase boundaries, before a long conversation ends, and before switching major tasks.

## Immediate resume point

APP-01 is complete. Production builds for all three apps passed outside the sandbox;
the previous Turbopack access error was an execution-permission limitation.
Typecheck, lint, format:check, and six live development HTTP checks passed.
Next ticket: finish DB-02 (API connection pool, lifecycle, transaction helpers).
Inspect current files before starting: user added pg, @types/pg, and dotenv already.
Do not implement AUTH-01 or seed data as part of a DB-02-only request.

Next.js generated apps/web/AGENTS.md and changed next-env.d.ts to development route
type paths while running. These are expected generated changes, not application
features. Root AGENTS.md has the pending checkpoint-reading instruction from the
previous turn. No commits or pushes were made by the assistant.

## Repository and user context

- Workspace: `C:/Users/Devon/OneDrive/Desktop/Projects/CSPH_TechnicalExam`.
- Branch: `develop`.
- Remote: https://github.com/devonjavier/Forms_App.git
- Latest observed commit: `8448bb7` (add connection-pooling packages).
- Earlier: `dc213e8` (monorepo scaffold), `f901bd0` (append-only migration guard).
- Working tree was clean immediately before creating this checkpoint.
- User wants to understand and defend each feature for a follow-up interview.
  Explain meaningful choices in plain language; avoid implementing the whole backlog.
- Read `AGENTS.md` for the full coding, scope, verification, and tool rules.
- `docs/` is intentionally ignored by the current `.gitignore`. Local design notes
  exist there but do not travel in a Git checkout. This root checkpoint is trackable.
- Never unnecessarily read/print `.env`; do not expose secrets to Next.js clients.
- No default subagent delegation. Do not push, send email, or deploy without scope.

## Assessment requirements and agreed product behavior

Source PDF: `C:/Users/Devon/Downloads/takehome_forms_app_1 (1).pdf`.
Email deadline: Tuesday, October 13, 2026; exact cutoff unspecified. Deliver a public
GitHub repo. Extra features do not count. AI assistance allowed; ownership expected.

- Required stack: Express + TypeScript API, Next.js + TypeScript web, PostgreSQL,
  JWT authentication, Docker Compose local DB, three apps in one monorepo.
- Register/login for owners; all management is scoped to authenticated ownership.
  Public published forms can be viewed/submitted without login.
- Eight types: short_text, long_text, date, dropdown, multi_select, multiple_choice,
  checkboxes, linear_scale. Requiredness/options/ranges must be server-validated.
- Every form always collects required format-valid email, separate from questions.
  Repeated submissions from one email are allowed.
- Working drafts may be incomplete. Publish requires nonblank title, >=1 question,
  nonblank question labels. Duplicate question labels are allowed.
- Nonblank distinct trimmed option labels. Required choice questions need >=2 options,
  except checkboxes allow one required acknowledgment. Optional choice questions >=1.
- Linear scales use integer endpoints with min < max; end labels optional.
- Required whitespace-only text is invalid. Optional blank answers display
  Not answered and export as empty cells. Type changes clear incompatible draft config.
- Each intentional confirmed publication creates a NEW immutable version, even for
  identical content. Same publication action UUID on network retry is idempotent.
- Saving drafts never changes public content. Only the current published version
  accepts submissions. Older submissions save nothing and receive a refresh notice
  (planned HTTP 409); no grace period and no automatic destructive page reload.
- Publish/unpublish/archive/submission use the same form-row locking protocol.
- Unpublish disables public access, retains owner responses/export. Republish creates
  another version. Archive/delete sets state without deleting stored data; all public
  and owner detail/response/export/webhook access is removed. No restore UI required.
- Historical responses retain original wording, options, order, and scale bounds.
- XLSX: server download, one worksheet per version with responses, one row per
  submission, email/time then original ordered questions; multiselect in one cell.
  Empty export default: latest published version headers, or email/time-only sheet
  for never-published draft. Archived forms cannot export.
- Webhooks: per-form URL/secret, commit response before asynchronous delivery, bounded
  timeout, no retries, logs visible to owner. Consumer verifies secret (401 if wrong),
  stores payloads in memory and displays a list. Keep consumer deliberately small.
- Seed later: two users, 3-4 forms, draft/published, all types, responses, webhook.
- No uploads, respondent editing, branching, collaborators, email notifications,
  React Native, or additional product features.

## Ticket state

| Ticket | Actual state |
|---|---|
| SETUP-01 | Complete: Docker/PostgreSQL work locally |
| DB-01 | User declared complete: schema and contracts established |
| DB-02 | Partial: migration/constraints complete; API pool/lifecycle/transactions pending |
| APP-01 | Complete: builds, static checks, startup and HTTP smoke checks passed |
| DB-03 | Not started: assessment seed data |
| AUTH-01 | Not started |
| FORM-01 / FORM-02 | Not started: builder and publication lifecycle |
| RESP-01 / RESP-02 | Not started: public submission and owner response views |
| EXPORT-01 | Not started |
| HOOK-01 / HOOK-02 | Not started: delivery/logs and consumer behavior |
| QA-01 / DOC-01 / RELEASE-01 | Future integrated verification and delivery |

Detailed local tickets: `docs/BUILD-PLAN.md`; design: `docs/DATA-MODEL.md`.
APP-01 completion has also been recorded in the local build plan.

## Database implementation

`database/migrations/001_initial_schema.sql` is already applied; never edit it.
Tables: users, forms, form_drafts, form_versions, version_questions, question_options,
responses, answers, answer_selections, form_webhooks, webhook_attempts, plus tooling
table schema_migrations. UUID IDs; timestamps timestamptz; date answers native date.

- Editable draft JSONB; published definitions normalized relationally.
- Composite FKs enforce current version belongs to form, question/response share
  a version, and selected option belongs to the answer's question.
- Answer question_type is constrained to definition type. CHECKs enforce scalar
  column compatibility, finite dates, short-text line rules, scale configuration.
- Selection slot zero plus unique slot prevents multiple single-choice selections.
- Unique answers, selections, ordered positions, and publication action per form.
- Published definition triggers reject UPDATE/DELETE. Later INSERTs are NOT blocked;
  publication services must atomically create the tree and prohibit later appends.
- Schema does NOT implement ownership, requiredness, scale-answer bounds, complete
  question coverage, current-publication submission checks, or concurrency services.
  Those are explicitly later API responsibilities, not verified features.
- Indexes support parent/order, owner lists, response/time, and webhook log lookups.
  Structural review found core relationships sound; no workload benchmark performed.

Migration tooling:

```powershell
.\database\migrate.ps1
.\database\test.ps1
.\database\test-migration-history.ps1
.\database\check-migration-files.ps1 -BaseRevision origin/develop
.\database\test-migration-files.ps1
```

Migrate/test/history scripts accept `-ConnectionMode Psql` with standard PG* environment
variables; default uses local Compose container credentials. Runner uses transaction,
advisory lock, normalized SHA-256 checksums, safe replay, and rejects missing applied
files before running pending SQL. Empty migration directory is also checked.
Regression tests use rollback fixtures/isolated temporary directories and Git repos.

Verified previously: real PostgreSQL constraint tests, safe replay, missing history,
unchanged/new migration acceptance and edit/delete/rename rejection all passed.

## GitHub Actions

`.github/workflows/migrate.yaml`: watches database/workflow/Compose changes on
develop/main pushes and PRs, plus manual dispatch with required baseline revision.
Full Git history, append-only file comparison, PostgreSQL 18 service, shared runner
in Psql mode, replay, constraint tests, and migration-policy regression checks.
PR baseline = base SHA; push = previous SHA; new branch = merge base with default
branch; initial repository push = empty Git tree.

Confirmed hosted SUCCESS for the earlier workflow at commit `24279c1`:
https://github.com/devonjavier/Forms_App/actions/runs/37900595463
All individual steps passed. Later guard changes passed local checks, but their
hosted runs have NOT been inspected. Do not imply that older success verifies HEAD.
This is CI, not persistent-database deployment. Branch protection has not been set
by the assistant. Avoid resetting databases or removing volumes.

## APP-01 implementation and tooling

- npm workspaces (`apps/*`) with root package-lock.json; Node 24 / npm 11.
- apps/api: Express 5.2.1, strict TS NodeNext; /health JSON liveness and JSON 404.
  app.ts exports Express app separately; server.ts validates port and handles shutdown.
- apps/web: Next 16.4.0 App Router, React 19.3.0; simple responsive placeholder page.
  No auth, API calls, forms, or browser secrets. Uses Next-generated route types.
- apps/webhook-consumer: Express placeholder HTML and /health; NO POST receiver yet.
- Ports: web 3000, API 4000, consumer 4001.
- Root `npm run dev` uses concurrently; individual dev scripts available.
- Servers use Node optional per-app `.env` loading and tsx in dev. Root `.env` stays
  Compose-only. Next.js does not receive root DB credentials.
- Shared tsconfig.base.json strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes.
- TypeScript 5.9.3; ESLint 10.12.0 + typescript-eslint; Prettier; one formatter/linter.
- Removed optional eslint-config-next after its transitive dependency advisories;
  current lint is JS/TS recommended rules, not the Next-specific preset.
- Initial install eventually succeeded with zero npm audit vulnerabilities after
  lint-tool changes. Audit result preceded latest user-added database packages.
- npm warned about esbuild install-script allowlisting during installation; actual
  tsx development startup subsequently passed for API and consumer.
- User's latest commit adds root pg ^8.23.1, @types/pg ^8.23.1, dotenv ^18.0.6.
  Only manifests/lockfile changed in that commit; no pool implementation exists.
  Preserve these additions; review workspace placement when implementing DB-02.
- SQL/psql remains migration authority. README proposes pg + parameterized SQL for
  DB-02, avoiding a competing ORM migration system.

Last scaffold checks:

| Check | Result |
|---|---|
| npm run format | Passed; formatted app sources/config |
| npm run lint | Passed |
| npm run typecheck | Passed for all 3 apps, including Next type generation |
| API/consumer build | Passed |
| Next production build | Passed on unrestricted retry; static routes generated |
| HTTP startup smoke checks | Passed: web /, API /health, consumer / and /health, API/consumer unknown-route 404 |
| npm run format:check | Passed |

Typecheck and lint were rerun successfully with the user's current dependency set.
Health endpoints are process liveness only. Database readiness, API integration,
production hosting, and visual browser QA have not been claimed or implemented.

## Resume prompt

"Read AGENTS.md and PROGRESS.md, inspect current files/status, and finish DB-02's
API connection lifecycle and transaction helpers. Preserve my latest changes.
Keep scope to that ticket and update PROGRESS.md as you work."
