# Forms App

For a read-only database walkthrough alongside the UI, see
[PostgreSQL lifecycle trace](POSTGRESQL-TRACE.md): drafts, immutable versions,
questions/options, responses, selections and delivery logs.

Take-home forms application built with Next.js, Express/TypeScript and PostgreSQL
in an npm workspace monorepo. Owners create and publish forms; respondents submit
without an account. Responses retain their original question versions, export to
version-specific XLSX sheets, and trigger asynchronous webhooks with delivery logs.
A separate consumer demonstrates receipt and displays payloads.

For the code and design explanation, see the
[architecture walkthrough](ARCHITECTURE-WALKTHROUGH.md).

## Run the applications

For the ordered first-run procedure, acceptance demo and interview walkthrough,
see [Phase 5 handoff](PHASE-5-HANDOFF.md). Run `npm test` for all application
regression suites once PostgreSQL and the API environment are configured.

Use Node.js 24 and npm 11. This repository uses npm workspaces with one root
package-lock.json; run installs from the repository root.

```powershell
npm ci
# Start PostgreSQL and configure the API as described below before npm run dev.
npm run dev
```

| App | Address | Current behavior |
|---|---|---|
| Next.js web | http://localhost:3000 | Home, login, registration and your forms |
| Express API | http://localhost:4000/health | JSON liveness response |
| Webhook consumer | http://127.0.0.1:4001 | Received payload list; secret-checked POST /webhooks |

Press Ctrl+C to stop the development apps. You can instead run one app with
`npm run dev:web`, `npm run dev:api`, or `npm run dev:consumer`.

The API and consumer use `tsx watch`, excluding `node_modules`, so dependency-file
notifications do not restart them and interrupt active requests. Application edits
still restart the relevant server. After changing dependencies or environment files,
restart `npm run dev` manually. Watcher regression check: `node scripts/test-dev-watch.mjs`.

After updating these development scripts, stop and restart an already-running
`npm run dev` once. Intentional application edits still restart the API and may
briefly interrupt in-flight requests; development watching is not zero-downtime
deployment.

The API requires PostgreSQL and checks its connection before opening the HTTP port.
`GET /health` reports process liveness; `GET /ready` queries PostgreSQL and returns
200 when available or a generic 503 without database details when unavailable.
Readiness verifies connectivity, not migration version or application completeness.
The consumer requires WEBHOOK_SECRET; copy its example environment file on first setup.

Root `.env` remains Docker Compose configuration. The API and consumer optionally
load their own `apps/<name>/.env` via Node's environment-file support; copy their
`.env.example` when configuring them. Neither server reads root `.env`. No database
credentials are passed to Next.js or exposed using NEXT_PUBLIC_. The API needs
PGHOST, PGPORT, PGUSER, PGDATABASE, and PGPASSWORD (host/port have local defaults).

On first setup, copy `apps/api/.env.example` to `apps/api/.env` and set PGPASSWORD
to the same value as root POSTGRES_PASSWORD. Match PGUSER/PGDATABASE/PGPORT to the
Compose settings if customized. Do not overwrite an existing API environment file.
Set a random JWT_SECRET in `apps/api/.env` (at least 32 bytes). Generate one locally:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Keep it server-side and out of Git. Set WEB_ORIGIN=http://localhost:3000 exactly,
without a trailing slash. Use that hostname consistently in the browser. Next.js
forwards `/api/*` to the API at `http://127.0.0.1:4000`; change API_INTERNAL_URL in
`apps/web/.env` if the API runs elsewhere, and restart/rebuild Next.js afterward.
The API_INTERNAL_URL setting is server-only and contains no database credentials.

Run `docker compose up -d --wait`, apply migrations, seed if desired, then `npm run dev`.

```powershell
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
```

The application tests require local PostgreSQL and the configured environment;
integration suites use isolated test schemas. The watcher regression above is a
separate check and is not included in `npm test`. Hosted GitHub Actions results
must be checked independently of local test success.

`npm run format` applies the single Prettier configuration to application source.
After building, run each desired app in its own terminal:

```powershell
npm run start --workspace @forms/api
npm run start --workspace @forms/web
npm run start --workspace @forms/webhook-consumer
```

Shared strict TypeScript options live in tsconfig.base.json. Node servers use
NodeNext modules; Next.js uses its bundler configuration and generated route types.
The API exports createApp(pool, authConfig) separately from its listening server so tests can
use a pool and an ephemeral HTTP port. server.ts is the entry point; an index.ts
file is not required for PostgreSQL connections or migrations.

Dependencies stay focused: Express handles HTTP, Next/React render the web UI,
tsx runs TypeScript during development, concurrently starts all three processes,
and ESLint/Prettier provide linting/formatting. Existing SQL migrations remain the
schema authority. The API uses the pg driver with parameterized SQL, without a second
ORM migration system. Existing root pg/dotenv dependencies are preserved; the API
also declares pg and its types as workspace dependencies. Node loads its environment
file, so dotenv is not needed by the current server implementation.

### Navigation and loading

The shared header displays the verified account email and sign-out controls on
owner pages. Public `/f/:slug` pages omit the account header and profile request.
Authenticated visitors to the home page are directed to their forms.

After login or registration succeeds, the page shows **Opening your forms** until
navigation completes. Forms routes have a loading boundary, and individual screens
show their own data-loading/error states. These states do not require a fixed delay.
The JSON client retries failed GETs once within its 10-second timeout; mutations
are never retried automatically. Publication has a separate action-ID retry contract.

### Troubleshooting local connections

- Open the website on port **3000**. Port **4000** serves the API; its root returning
  `NOT_FOUND` is expected. Use `/health` for liveness and `/ready` for database access.
- `ECONNREFUSED` means the target was not accepting the connection. Confirm the API
  startup message and its configured port before retrying.
- `ECONNRESET` means a connection was interrupted. Check the API log at the same
  time. A reproduced incident showed the old Node watcher restarting Express after
  an `iconv-lite` dependency notification. The current development watcher excludes
  dependencies; restart the dev command to adopt it.
- Actual application-source edits still cause restarts. A loading screen cannot
  prevent those interruptions, and a failed write may already have committed before
  the reply was lost. Do not assume a repeated submission is harmless.
- Use `localhost:3000` consistently: switching hostname changes the browser origin
  and cookie scope, and may fail the API's trusted-origin check.

## API database lifecycle and transactions

`apps/api/src/database.ts` creates a bounded pool (10 connections, 2-second connection
timeout, 10-second idle timeout, 5-second statement timeout). An idle connection
error is handled without printing credentials or raw SQL. DATE values are returned
as YYYY-MM-DD strings; timestamptz remains a Date representing an instant.

Use pool.query for an independent query. Use withTransaction(pool, async client => ...)
for related writes and use that supplied client for EVERY query. It commits on
success, rolls back on failure, preserves the original error, and always releases
the connection. Failed rollback discards the broken connection. A swallowed SQL
error cannot turn PostgreSQL's aborted transaction into a reported success.
Do not manually BEGIN/COMMIT/ROLLBACK or release the client inside that callback.
Do not nest the helper or perform external webhook requests inside a transaction.

Startup fails if PostgreSQL cannot be reached. SIGINT/SIGTERM stops accepting HTTP
requests, drains active requests, and ends the pool, with a 10-second shutdown limit.
Migrations are explicit commands, not automatic side effects of starting the API.
Ownership and publication locks are implemented in the domain services; the
transaction helper manages connections and commit/rollback, not those rules.

```powershell
npm run test:db
```

These real PostgreSQL tests use temporary tables that vanish when the connections
close. They verify commit, rollback, client reuse, failed rollback recovery, date
handling, and HTTP readiness/liveness. They terminate only their own test backend
for one failure test; no application records are deleted. The test command alone
loads the root Compose `.env` and maps POSTGRES_* to PG* unless PG* is already set.
CI provides PG* directly. Application startup does not use that test-only fallback.

## Prerequisites on Windows

1. Install WSL 2 using `wsl --install` in an Administrator PowerShell window.
   Restart Windows if requested and finish any WSL setup prompts.
2. Install Docker Desktop for Windows and use its WSL 2 backend and Linux containers:
   https://docs.docker.com/desktop/setup/install/windows-install/
3. Start Docker Desktop, wait for its engine to be ready, and open a new terminal.
4. Check `docker --version`, `docker compose version`, and `docker info`.

Node.js runs the applications and their tests. PostgreSQL does not need a separate
Windows installation: Docker Compose runs the official PostgreSQL 18 image.

## Start the database

Run these commands from the repository root in PowerShell:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
# Edit .env to choose your local development password.
docker compose up -d --wait
docker compose ps
docker compose exec db psql -U forms_dev -d forms_app -c "SELECT current_database(), version();"
```

Copy the environment example only on first setup; keep an existing `.env`.
The credentials are for local development. `.env` is ignored by Git.
The configured PostgreSQL user is the image's bootstrap superuser, suitable for
this local setup; production would use separate restricted application credentials.

The database is available at `127.0.0.1:5432`, database `forms_app`, user
`forms_dev`, and the password from `.env`. If you change the user or database,
adjust the example commands accordingly. If port 5432 is occupied, change
`POSTGRES_PORT` in `.env` and use that port in your database client/API config.

To open the SQL terminal:

```powershell
docker compose exec db psql -U forms_dev -d forms_app
```

Enter `\dt` to list tables and `\q` to exit.

## Migrate and check the database

With Docker Desktop and the database running, execute from the repository root:

```powershell
.\database\migrate.ps1
.\database\test.ps1
.\database\test-migration-history.ps1
```

The migration runner applies numbered SQL files from `database/migrations` in a
transaction using the container's `psql`. It reads credentials from the container's
environment without printing them. `schema_migrations` records applied filenames
and SHA-256 checksums. Repeating the command skips applied files; changing an applied
file fails. A ledger entry whose file is missing also fails, listing the missing
filenames before any pending migration executes (including with an empty directory).
Restore the original file; do not erase its ledger entry to bypass the check.
Add a new numbered migration for future schema changes. Existing tables
with conflicting names fail instead of being overwritten. There is no reset command.

The tests insert temporary fixtures inside a transaction, exercise constraints in
real PostgreSQL, and roll back. They cover all eight answer storage types, version
and option membership, duplicate selections/answers, immutable definition updates,
and retention after archival. They are not API/authentication or concurrency tests.
The history test runs the real runner with temporary incomplete migration directories
against the applied ledger. It verifies empty-directory rejection and rejection before
pending SQL executes, without moving repository files or changing database records.

See [the schema migration](database/migrations/001_initial_schema.sql) for table,
index and constraint definitions. Editable JSONB drafts are separate from immutable
published definitions; responses reference their original version. Composite foreign
keys bind answers to that version and selections to their question's options.
Ownership, complete publication validation and stale-submission locking belong in
the API services; foreign keys alone do not enforce those rules. Seed instructions
and the historical response examples appear below.

## Authentication and ownership (AUTH-01)

Open `/register` to create an account, `/login` to sign in, and `/forms` to see your
forms. The two seeded accounts below work with the login screen. Create a form or
select an existing form to edit its private draft.

Passwords are 12–128 characters, preserved exactly (never trimmed), and hashed with
asynchronous Node scrypt before acquiring a database connection. Emails are trimmed,
lowercased and format-validated. Unique email constraints handle concurrent duplicate
registration. Login failures use the same message for unknown accounts and incorrect
passwords, and unknown accounts still perform a dummy password derivation.

The API uses `jose` for signed JWTs and `cookie` for cookie parsing. JWTs use HS256,
issuer `forms-api`, audience `forms-web`, subject=user UUID, and a one-hour expiry.
Verification restricts the algorithm and requires subject, issued-at and expiry;
each protected request also checks that the user still exists. Password hashes and
tokens are never returned in JSON. No tokens are stored in localStorage.

The `forms_session` cookie is HttpOnly, SameSite=Lax, host-only, Path=/ and lasts
one hour. Set NODE_ENV=production on the API for Secure cookies; this also requires
an HTTPS WEB_ORIGIN. Local HTTP development deliberately leaves Secure off.
Next.js forwards API calls on the browser's origin, so CORS is unnecessary.
State-changing requests must include an Origin matching WEB_ORIGIN exactly;
registration/login also require application/json. This protects cookie-authenticated
requests, including login/logout, against cross-origin browser submissions.
Command-line clients must send the same Origin header and manage the cookie jar.

Logout clears the browser cookie. JWTs are stateless: a copied token remains valid
until expiry, there is no refresh token or per-session revocation table, and users
sign in again after an hour. Password reset, email verification and distributed
login throttling are not implemented in this bounded assessment.

| API route (prefix `/api` through Next.js) | Result |
|---|---|
| POST /auth/register | `{email,password}` -> 201 `{user:{id,email}}` and session cookie |
| POST /auth/login | `{email,password}` -> 200 `{user:{id,email}}` and session cookie |
| POST /auth/logout | Clear session cookie; 204 |
| GET /auth/me | Authenticated user; missing/invalid/expired session -> 401 |
| GET /forms | Non-archived forms owned by the verified user |
| GET /forms/:formId | Owned, non-archived summary; absent/foreign/archived -> same 404 |
| POST /forms | Create an empty private draft owned by the session user; 201 `{form:{id}}` |
| GET /forms/:formId/draft | Owner-only `{definition,etag}` plus ETag header; absent/foreign/archived -> 404 |
| PUT /forms/:formId/draft | JSON definition with `If-Match` from GET; 200 `{etag}` for next save; missing precondition -> 428, changed draft -> 409 |
| DELETE /forms/:formId | Archive under a form-row lock; 204; retain history |
| GET /forms/:formId/publication | Owner-only slug, online state and latest version |
| POST /forms/:formId/publish | `{publicationActionId,definition}`; 201 for new version, 200 for replay |
| POST /forms/:formId/unpublish | Take offline, retain pointer and history; 204 |
| GET /public/forms/:slug | Anonymous current published definition; offline/draft/archived/missing -> 404 |

Management SQL takes the owner UUID from the verified session, never request
parameters/body. Both list and direct-ID lookups scope by owner and deleted_at.
Mutation, response, export and webhook routes preserve that boundary through the
owning form. Authentication is mounted on management routes; public definition
reads and submissions require no login. Public POSTs still require the configured
Origin header.

Errors have `{error:{code,message}}` shape. Malformed JSON, invalid credentials,
oversized bodies, unsupported content types, expired sessions and ownership failures
produce explicit HTTP statuses. Unexpected errors return a generic 500 without
stack traces, SQL or credentials. Auth/management responses use Cache-Control:no-store.

```powershell
npm run test:auth
npm run test:network --workspace @forms/web
```

These HTTP integration tests use an isolated schema and a single-backend test pool
inside a rollback-only transaction. They verify seeded logins, registration hashing,
duplicate-registration races, invalid input, expired/forged/wrong-claim tokens,
two-owner isolation, archived visibility, trusted origins and logout. Their token
key is test-only. No JWT_SECRET environment variable is needed for test commands.
The migration workflow includes the auth suite. Browser checks cover login/reload/
logout, wrong password, duplicate registration, two-owner lists and a 390px layout.

Additional security checks cover missing/malicious Origins on both account routes,
actual server startup with missing/short secrets, altered session signatures, and
absence of draft definitions in unauthenticated responses. Unknown-account and
wrong-password logins both execute real scrypt with identical cost parameters and
`timingSafeEqual`; this does not promise constant duration for the entire HTTP request.
Network tests cover disconnected requests, interrupted JSON bodies, recovery, and
the ten-second request timeout. The account form uses POST even before hydration,
preventing a native submission from placing credentials in the URL. Normal login
still requires JavaScript. The migration workflow also runs the network tests.

## Draft builder (FORM-01)

The builder supports all eight question types, required flags, question/option
ordering, option labels and linear-scale endpoints/labels. Stable UUIDs identify
editor questions and options; their array order defines position. Changing a type
preserves its ID, label and required flag while clearing options/scale settings.
Draft IDs remain separate from immutable published record IDs.

Saving permits blank titles/labels, no questions/options, duplicate option labels,
and blank or reversed scale endpoints. Publication validates these more strictly.
Saving still checks supported types, boolean flags, unique UUIDs, text lengths and
integer-or-null scale endpoints. Unrelated/incompatible fields are stripped.
The pure browser-safe contract in `apps/api/src/contracts/draft.ts` is shared with
the frontend; it imports no server modules, environment variables or credentials.

Limits: 100 questions, 100 options per question, 500 title characters, 1,000 label
characters, 10,000 description characters, and 256 KiB per draft JSON request.
Publishing allows 257 KiB for the same definition plus its action-ID envelope.
NUL and unpaired surrogate characters are rejected before database writes. Auth routes
retain their 16 KiB limit. Failed saves keep the editor contents and show an error.
Explicit save feedback distinguishes unsaved changes from the saved draft.
The editor registers unsaved changes with the shared account header. Same-tab
header navigation and sign-out ask for confirmation before leaving; Cancel keeps
the edits and session. Successful saving or leaving the editor clears the guard.
Document exits retain the browser's unsaved-change warning. This is explicit-save
behavior, not autosave or durable offline storage.
Draft saves compare the normalized definition SHA-256 ETag under the existing
owner/form row lock. Two tabs cannot silently overwrite different content: a stale
`If-Match` returns `409 DRAFT_CHANGED`. Local edits remain visible until the owner
explicitly confirms reloading the saved draft. There is no automatic merge. A lost
save acknowledgement may require this same reload; reload once after upgrading an
already-open editor to this API contract.

Create inserts the form and draft atomically. Save and archive verify ownership
while locking the form root. Archive sets `deleted_at` and disables publication;
the current version and every stored response remain. The UI requires confirmation,
and there is no restore feature. Archived forms disappear from the owner list and
all implemented management reads/writes return 404. Publish/submission
operations acquire this same root lock. Draft ETags need no schema migration.

```powershell
npm run test:forms
```

The integration suite uses a uniquely named, disposable PostgreSQL schema, genuine
committed transactions, and multiple connections. It removes only that test schema
afterward. Tests cover atomic create rollback, ownership and Origin checks, all
eight draft types, incomplete saves, stable ordering, history preservation, and a
save observed waiting behind an archive before being rejected. CI runs this suite.

## Publication (FORM-02)

Save the draft, choose Publish changes and confirm. Every fresh confirmation creates
a new version, even with identical content. Publishing an offline form also creates
a new version. Publishing requires a nonblank title and at least one question with
a nonblank label. Choice labels must be nonblank and distinct after trimming
(case-sensitive); optional choices and checkboxes allow one option, while other
required choices need two. Scale endpoints must be integers with minimum less than
maximum. Published option labels are trimmed; the draft remains unchanged. Question
labels may repeat.

The request carries a client-generated action UUID and the saved definition the
owner reviewed. Under a form-row lock, the API checks for an existing action first.
A replay returns its original version without changing the pointer or bringing an
unpublished form online. A new action compares the normalized expected definition
with the stored draft (409 DRAFT_CHANGED on mismatch), validates it, and atomically
inserts the version/questions/options before switching the pointer. Each version
gets fresh question/option IDs. Existing unique action and version-number constraints
remain the final integrity checks. No migration is required.

The browser retains an uncertain action and snapshot for Retry publication after
network/5xx failures while that editor page stays open. Keep it open until resolved;
pending action state does not survive reload/navigation. API clients must reuse the
original action ID for transport retries.

Unpublish disables public access while retaining owner access and the current pointer.
Archive additionally removes owner application access. Save, publish, unpublish and
archive acquire the same root lock and retain historical rows. Submission must
acquire that lock too when implemented in RESP-01.

The anonymous JSON endpoint reads visibility and the current immutable definition
in one SQL statement. It includes formVersionId and ordered questions/options,
never drafts, users, responses or webhook secrets. Public responses use no-store.
The builder shows the stable slug; public web rendering and the shareable frontend
link are RESP-01 work. There is no submission endpoint yet.

```powershell
npm run test:publication
```

The suite uses a uniquely named disposable PostgreSQL schema, removed afterward.
It covers validation, concurrent duplicate/fresh actions, replay after unpublish,
stale draft comparison, mid-tree rollback, public visibility, ownership, archive/
publish locking and historical retention. CI runs it; hosted execution is separate.

To inspect archived response counts, follow the version relationship (responses
has form_version_id, not form_id):

```sql
SELECT f.id, f.deleted_at,
       (SELECT count(*) FROM form_versions v WHERE v.form_id=f.id) AS versions,
       (SELECT count(*) FROM responses r
        JOIN form_versions v ON v.id=r.form_version_id
        WHERE v.form_id=f.id) AS responses
FROM forms f
WHERE f.deleted_at IS NOT NULL;
```

## GitHub Actions migration checks

`.github/workflows/migrate.yaml` runs when `database/**`, the workflow, or
`docker-compose.yml` changes on pushes to develop/main or pull requests targeting
those branches. Manual dispatch is also configured (GitHub requires the workflow
on the default branch for the manual-run UI).

Before applying SQL, CI compares committed migration files with the PR base commit
or the previous push commit. Existing files cannot be edited, deleted, or renamed;
new files are allowed. A new branch uses its merge base with the default branch;
an initial repository push has an empty baseline. Manual runs require a baseline
branch, tag, or commit. Unresolvable baselines fail instead of skipping the check.

Run the file-policy check and its isolated Git-fixture regression tests locally:

```powershell
./database/check-migration-files.ps1 -BaseRevision origin/develop
./database/test-migration-files.ps1
```

The checker compares commits, not uncommitted changes. CI includes full Git history
and runs regression tests for additions, edits, deletions, and renames.

Each run uses an isolated PostgreSQL 18 service: apply migrations to a fresh database,
apply again to verify replay, then run the rollback-only constraint tests and missing
migration-history regression checks. CI uses
disposable credentials declared in the workflow, not your local `.env` or a hosted
database. No GitHub secrets are required for these tests.

The same PowerShell scripts support a direct PostgreSQL connection when `psql` is
installed and PGHOST, PGPORT, PGDATABASE, PGUSER, and PGPASSWORD are supplied in the
environment (or equivalent libpq authentication configuration):

```powershell
./database/migrate.ps1 -ConnectionMode Psql
./database/test.ps1 -ConnectionMode Psql
```

The default remains Compose, so existing local commands are unchanged. Direct mode
never reads `.env` automatically and disables interactive password prompts. The SQL,
checksum checks, ledger, transaction, and tests are shared between both modes.

This is CI validation, not deployment to a persistent database. A deployment job
would require a chosen target and protected connection credentials. Fresh-database
CI does not prove an upgrade preserves real data. The Git check protects existing
migration files across revisions; the ledger separately detects drift or missing
files when run against an already-migrated database.
If this workflow becomes a required branch-protection check, account for its path
filters: skipped workflows can leave required checks pending on unrelated changes.

## Assessment sample data (DB-03)

With PostgreSQL running and `apps/api/.env` configured as above, run from the root:

```powershell
./database/migrate.ps1
npm run seed
npm run test:seed
```

The seed command uses the API's PG* connection settings. Run it only against the
development/assessment database you intend to populate. CI supplies PG* directly.
No extra dependencies or database reset are needed.

| Owner email | Form slug | State and sample responses |
|---|---|---|
| owner.alpha@example.test | demo-survey | Published v2; all eight types in both versions; 2 responses on v1, 4 on v2 |
| owner.alpha@example.test | demo-draft | Never published; empty title/questions intentionally allowed in a draft |
| owner.beta@example.test | demo-acknowledgment | Published; required single-checkbox question; zero responses |
| owner.beta@example.test | demo-archived | Archived/offline; one historical response retained |

Both demo accounts use password `FormsDemo!2026`. These are public sample
credentials, not production credentials. Passwords are stored as individually
salted scrypt hashes using Node crypto, formatted
`scrypt$32768$8$1$<hex salt>$<hex key>` (64-byte key; the hexadecimal salt string
is passed as UTF-8 to scrypt). AUTH-01 verifies this same format; seed accounts can
sign in without re-seeding or changing stored password hashes.

Version 2 replaces the old notes question with a new question, renames Engineering
to Product Engineering, and changes the scale maximum from 5 to 10. Version 1's
definitions and answers retain their own IDs. Draft questions/options have separate
stable editor IDs. Both text questions deliberately share the label "Details" to
exercise ID-based rendering and export columns.

Answer fixtures include optional blanks, repeated respondent emails, minimum and
maximum ratings, leap-day dates, multiple selected options in a different order
from the option list, Unicode, quotes, multiline text, HTML-looking text, and
`=SUM(1,2)` stored as literal text. These exercise UI/XLSX edge cases; they do not
claim escaping or export functionality already exists. Invalid foreign options,
cross-version answers, and duplicates belong in rollback-only constraint tests,
not in persistent sample records.

The survey webhook is configured for `http://localhost:4001/webhooks` with sample
secret `demo-webhook-secret-local-only`. No HTTP calls or pretend delivery attempts
are made by seeding. The consumer example environment uses the matching demo secret.
This URL assumes the API and consumer run on the host.

All inserts share one transaction and a seed-specific advisory lock. Stable IDs
identify the fixture set. If both owners and all four form roots already exist,
the command reports `already present` and changes nothing, preserving subsequent
draft/password edits and new responses. A partial set fails for manual inspection;
conflicting IDs, emails, or slugs roll back the whole operation. Rerunning is not a
reset or repair command, and never restores manually removed fixture children.

`npm run test:seed` applies migrations in an isolated PostgreSQL schema inside a
transaction, checks fixtures, password hashes, history, collision rollback and
edit-preserving replay, then rolls everything back. It requires schema-creation
permission (available to the local Compose and disposable CI database users).
The migration workflow runs these tests and executes the actual seed command twice.

## Persistence and stopping

PostgreSQL writes its database files to the named `postgres_data` volume, mounted
at `/var/lib/postgresql` for the PostgreSQL 18 image. Docker manages these files
outside the repository. Stopping or recreating the container preserves the volume.

```powershell
docker compose stop
docker compose start
# Remove the container/network while retaining the database volume:
docker compose down
# Recreate and start:
docker compose up -d --wait
```

Do not add `--volumes`/`-v` to `docker compose down` unless you intend to erase the
local database. A persistent volume is not a backup.

Initialization variables apply when the database volume is first created.
Changing the password in `.env` later does not change an existing database user's
password; update that password through SQL and align the local configuration.

## Application layout

```text
apps/api                 Express + TypeScript
apps/web                 Next.js + TypeScript
apps/webhook-consumer    Minimal webhook receiver and list view
```

The applications will initially run on Windows while PostgreSQL runs in Docker.
The API connects to PostgreSQL; the browser never receives database credentials.

## Public forms and submissions (RESP-01)

Publish a saved form and choose **Open public form** in the builder. Its shareable
web address is `/f/<slug>`; the seeded survey is `http://localhost:3000/f/demo-survey`.
Respondents do not need an account. Draft, unpublished and archived forms are hidden.

`GET /public/forms/:slug` returns only the current published definition.
`POST /public/forms/:slug/responses` accepts JSON:

```json
{
  "formVersionId": "<published version UUID>",
  "email": "respondent@example.test",
  "answers": [
    { "questionId": "<published question UUID>", "value": "An answer" }
  ]
}
```

Use published question/option IDs from GET, never draft IDs. Answer values are:

| Question type | Value |
|---|---|
| Short text | Single-line string, at most 1,000 characters |
| Long text | String, newlines allowed, at most 10,000 characters |
| Date | Real `YYYY-MM-DD` date, years 0001–9999 |
| Dropdown / multiple choice | One option UUID |
| Multi-select / checkboxes | Array of distinct option UUIDs for that question |
| Linear scale | Integer between the published endpoints, inclusive |

The request limit is 2 MiB of serialized UTF-8 JSON, including JSON escaping and
metadata. The browser checks this shared limit before sending and retains entered
answers with a message to shorten long-text answers when exceeded; the API also
enforces it independently. Individual field limits do not guarantee the whole
response fits. Invalid public slugs return `404 NOT_FOUND`; malformed percent
encoding returns `400 INVALID_PATH`, without database writes or webhook delivery.
Optional omitted/null/blank values and empty multiple
selections become unanswered; malformed values still fail. Every question gets one
answer row, with null scalar columns and no selections when unanswered. Email is
trimmed/lowercased; repeated emails are allowed. Required whitespace-only answers,
duplicate/unknown questions, foreign or historical options, invalid dates and
out-of-range scales return `400 INVALID_SUBMISSION` with a safe `field` identifier.
All browser mutations require the configured WEB_ORIGIN as their Origin header.

Respondent email uses practical ASCII mailbox syntax: a dot-atom local part (up to
64 characters, plus-addressing allowed) and at least two DNS-style domain labels
(each up to 63 characters, no leading/trailing hyphen). Control characters, empty
labels and consecutive local-part dots are rejected. Punycode domains are accepted;
quoted mailboxes and Unicode mailbox syntax are not supported. This is syntax
validation, not a DNS or mailbox-existence check. Incomplete browser number/date
entries show field errors rather than silently becoming optional blanks.

Submission locks the form row used by publish/unpublish/archive, then rechecks
visibility and the current version. Responses, answers and selections commit as one
transaction. A newer version returns `409 FORM_UPDATED`; offline or archived forms
return 404. The browser retains entered answers and asks the respondent to refresh
explicitly. A successful submission returns 201 with the response ID and timestamp.
These API responses use `Cache-Control: no-store`.

An in-flight guard prevents repeated clicks. Submission has no idempotency key:
if the server commits but the connection fails before confirmation, a manual retry
may create another response. After a successful commit, the API schedules webhook
delivery independently; a slow or failed receiver does not undo the submission.
See [Webhook settings and delivery](#webhook-settings-and-delivery-hook-01).

Run `npm run test:responses` for real PostgreSQL validation, rollback and both lock
orders of submit versus publish/unpublish/archive. The suite creates and removes
its own isolated schema and never resets application data. It also runs in the
migration workflow; hosted CI execution must be checked separately.

## Owner responses (RESP-02)

Choose **View responses** on a dashboard form. The owner list shows respondent
email, submission time and original version, newest first, with 50 rows per page.
Open **View response** for historical questions and selected choice labels.
Unanswered questions show **Not answered**; date answers retain YYYY-MM-DD.
Unpublishing keeps owner access; archiving hides both response routes.

Authenticated API routes (both no-store and owner-scoped):
- `GET /forms/:formId/responses?page=0`: form summary, responses, total, page, pageSize.
- `GET /forms/:formId/responses/:responseId`: historical detail in `response`.

Run `npm run test:owned-responses` for history, all eight answer types, ownership,
empty forms, sparse answers, pagination and archive checks against an isolated
PostgreSQL schema. The migration workflow includes this command; hosted execution
has not been observed. No additional migration is needed for these read views.

## Versioned XLSX export (EXPORT-01)

On a form's response list, choose **Export XLSX**. The authenticated API route is
`GET /forms/:formId/responses/export`; unauthorized requests receive 401 and
non-owned, missing or archived forms receive 404. Unpublished forms remain
exportable by their owner. Downloads use no-store and a UUID-based filename.

Each version **with responses** gets its own tab, named `Version 1`, `Version 2`,
and so on in version-number order. Empty intermediate versions are omitted. Each
sheet has Email and Submitted at (UTC), followed by numbered original question
labels in their original order. Numbering distinguishes duplicate labels. Rows
are oldest first; repeated emails remain separate rows. Different versions can
have different columns, so edits/deletions never change historical exports.

Unanswered values are blank. Multiple choices selected in one answer appear on
separate lines within one wrapped cell, in submission order. Date answers remain
YYYY-MM-DD text; timestamps use UTC ISO text; scales are numeric. User text is
written as literal strings, including values beginning with `=`; no formulas are
created. Headers are frozen and filterable.

With no responses at all, the export has a header-only sheet for the latest
published version, including after unpublishing. A never-published draft exports
a `Responses` sheet with only the two system headers, never draft questions.

The API builds a consistent database statement snapshot and writes the workbook
to the HTTP response using [ExcelJS](https://github.com/exceljs/exceljs#writing-xlsx).
This streams the download but holds the selected records/workbook in server memory;
it is not a constant-memory bulk-export pipeline. The frontend buffers the download
as a Blob, with a 60-second timeout. Excel row/column/cell-text limits return 422
before download headers rather than silently truncating answers. Large-scale export
benchmarking is outside the current assessment scope.

ExcelJS is server-only. Its UUID dependency is overridden to patched version 11.1.1
(the CommonJS v4 call used by ExcelJS remains compatible). Run `npm ci` after pulling
this change. Run `npm run test:export` for real PostgreSQL + XLSX round-trip checks.
The suite creates/removes its own schema and writes local review workbooks under
ignored `docs/review/`. The CI migration workflow runs it too.

## Webhook settings and delivery (HOOK-01)

Choose **Webhook** on a dashboard form to configure its receiver URL and secret,
inspect the latest 50 attempts, or disable future delivery. Refresh settings/logs
after submitting to see completion. Existing attempts remain after disabling.

Owner-only routes (all no-store):
- `GET /forms/:formId/webhook`: `{ webhook: { url, hasSecret, attempts } }`.
- `PUT /forms/:formId/webhook`: `{ "url": "http://localhost:4001/webhooks", "secret": "your-shared-secret" }`.
  Omit secret to retain an existing secret; the first configuration requires one.
- `DELETE /forms/:formId/webhook`: disables future delivery, returning 204.

The URL must be HTTP(S), at most 2,048 characters, without embedded credentials or
fragments. The secret is 1–512 visible ASCII characters without spaces; it is sent
only in `X-Webhook-Secret`, never returned by settings/public endpoints or attempt
logs. The secret is stored server-side in PostgreSQL; protect DB access/backups.
Use a dedicated shared secret rather than an account password. Do not put secrets
in URL query parameters, since destination URLs appear in owner logs.

The payload uses the immutable submitted version and original selected labels:

```json
{
  "form": { "id": "<form UUID>", "title": "Survey", "formVersionId": "<version UUID>" },
  "response": {
    "id": "<response UUID>", "submittedAt": "2026-10-11T09:00:00.000Z",
    "email": "respondent@example.test",
    "answers": [
      { "questionId": "<question UUID>", "label": "Team", "type": "dropdown", "value": "Support" }
    ]
  }
}
```

Answers are in historical question order. Text/date values are strings, dates are
YYYY-MM-DD, scales are numbers, dropdown/radio values are one selected label or
null, and multi-select/checkbox values are arrays of selected labels (empty when
unanswered). Other unanswered values are null. There are no option IDs, draft
content or webhook credentials in the payload.

The submission transaction captures the settings under the same root form lock
used for owner mutations. After COMMIT, the API sends 201 and schedules delivery
in the background. HTTP has a five-second timeout, no redirects and no retries.
No database connection is held during the HTTP wait. Every started delivery has
an attempt row, with completion timestamp, HTTP status or null, and a sanitized
error. Receiver response bodies and raw exceptions are never logged. Non-2xx,
including redirects, count as failures. Missing status is displayed without an
invented HTTP code. Unpublishing retains owner settings/log access; archiving
returns 404 for these routes. Already accepted jobs retain their captured settings.

This is deliberately in-process fire-and-forget, not a durable queue. A process
crash can lose an unscheduled/in-flight event or leave an attempt pending. Failure
to insert an attempt prevents the outgoing request; failure to finalize a log may
leave it pending. Both emit a sanitized server diagnostic without changing the
saved submission. Graceful shutdown drains current jobs within the existing
10-second shutdown deadline. There is no automatic recovery/retry.

Local/private HTTP destinations remain allowed in development when
`WEBHOOK_ALLOWED_ORIGINS` is unset. In production, startup requires that setting:
a comma-separated list of exact trusted origins without paths or trailing slashes,
e.g. `https://receiver.example.com,http://127.0.0.1:4001`. Scheme, host and port must
match; subdomains are not implicitly allowed. Settings writes and every delivery
(including existing configurations) enforce the list. Blocked deliveries are logged
without sending a request or failing the submission. Only list receivers controlled
by trusted operators. This is not a DNS-rebinding-proof network sandbox: production
also needs outbound firewall restrictions. Since the API runs on Windows, use the
consumer's Windows-host URL, as described below.

`npm run test:webhooks` uses a disposable PostgreSQL schema and local test receiver
for success, wrong secret, non-2xx, redirects, timeout, connection failure,
configuration snapshotting and owner/archive isolation. It runs in migration CI.

## Webhook consumer (HOOK-02)

On first setup, copy the example without overwriting an existing configuration:

```powershell
if (!(Test-Path apps/webhook-consumer/.env)) {
  Copy-Item apps/webhook-consumer/.env.example apps/webhook-consumer/.env
}
npm run dev:consumer
```

The consumer requires `WEBHOOK_SECRET` (1–512 visible ASCII characters, no spaces).
The example matches the seeded survey's demo secret; use a dedicated secret for
other data. It listens on **127.0.0.1:4001** by default. In the form's Webhook page,
set URL `http://127.0.0.1:4001/webhooks` and the same secret. The API and consumer
both run on Windows; Docker is only hosting PostgreSQL. Containerized deployment
would require a different network/binding configuration.

Submit the published form, then open `http://127.0.0.1:4001` and select **Refresh
deliveries**. The latest 50 payloads appear newest first, with receiver timestamps.
Payload JSON is escaped as text, including respondent HTML. The page has no login
and contains respondent data, so the server binds only to loopback. All responses
are no-store. Restarting the consumer clears its list; API response records and
delivery logs remain in PostgreSQL.

`POST /webhooks` checks exactly one `X-Webhook-Secret` header before parsing JSON.
Missing/wrong/duplicate headers return 401. JSON objects are accepted verbatim
with 204; malformed JSON returns 400, unsupported content type/encoding returns
415, and bodies exceeding 4 MiB return 413. The extra headroom accommodates
historical labels added to submissions. No retries or duplicate-event suppression
are provided; each accepted delivery occupies one history entry.

Run `npm run test:consumer` for receiver/HTML/history checks and
`npm run test:webhooks` for real PostgreSQL + API-to-consumer delivery, logging
failures, wrong secret, timeout, connection errors and ownership boundaries.
Both run in CI.

### Audit fixes: export bounds and sealed histories

Publication rejects multi-select/checkbox option sets whose trimmed labels, joined
with newline separators, exceed Excel's 32,767-character cell limit. Drafts may
still contain those options while editing. Every newly published selection can
therefore fit the existing one-answer-per-cell export layout. Historical definitions
are never truncated or rewritten. Existing over-limit cells still return an explicit
422; none of the local published multi-selection option sets exceeded this limit
when checked on October 12, 2026. Multi-select uses a collapsible selection dropdown;
checkbox questions keep their always-visible checkbox group.

Run the normal migration command after pulling these changes. Migration
`002_seal_published_definitions.sql` adds a server-assigned transaction marker.
Questions/options may only be inserted in their version's creation transaction;
commit automatically seals the tree. Existing versions have a NULL marker and
are already sealed. The original UPDATE/DELETE protections remain, including
protection of the marker. This relies on application roles not having privileges
to disable triggers or change the schema; it is not protection from a DB superuser.
No records or migration history are removed, and migration 001 is unchanged.
