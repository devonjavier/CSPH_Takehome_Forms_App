# Forms App

Take-home forms application. Local PostgreSQL, the initial relational schema, and
three runnable application scaffolds are implemented. Authentication, form building,
submissions, export, and webhook delivery are subsequent tickets.

## Run the applications

Use Node.js 24 and npm 11. This repository uses npm workspaces with one root
package-lock.json; run installs from the repository root.

```powershell
npm ci
# Start PostgreSQL and configure the API as described below before npm run dev.
npm run dev
```

| App | Address | Current behavior |
|---|---|---|
| Next.js web | http://localhost:3000 | Responsive placeholder home page |
| Express API | http://localhost:4000/health | JSON liveness response |
| Webhook consumer | http://localhost:4001 | Placeholder page; /health returns JSON |

Press Ctrl+C to stop the development apps. You can instead run one app with
`npm run dev:web`, `npm run dev:api`, or `npm run dev:consumer`.

The API requires PostgreSQL and checks its connection before opening the HTTP port.
`GET /health` reports process liveness; `GET /ready` queries PostgreSQL and returns
200 when available or a generic 503 without database details when unavailable.
Readiness verifies connectivity, not migration version or application completeness.
The consumer does not yet accept POSTs or receive payloads; HOOK-02 implements that.

Root `.env` remains Docker Compose configuration. The API and consumer optionally
load their own `apps/<name>/.env` via Node's environment-file support; copy their
`.env.example` when configuring them. Neither server reads root `.env`. No database
credentials are passed to Next.js or exposed using NEXT_PUBLIC_. The API needs
PGHOST, PGPORT, PGUSER, PGDATABASE, and PGPASSWORD (host/port have local defaults).

On first setup, copy `apps/api/.env.example` to `apps/api/.env` and set PGPASSWORD
to the same value as root POSTGRES_PASSWORD. Match PGUSER/PGDATABASE/PGPORT to the
Compose settings if customized. Do not overwrite an existing API environment file.
Run `docker compose up -d --wait`, apply migrations, then `npm run dev`.

```powershell
npm run typecheck
npm run lint
npm run format:check
npm run build
```

`npm run format` applies the single Prettier configuration to application source.
After building, run each desired app in its own terminal:

```powershell
npm run start --workspace @forms/api
npm run start --workspace @forms/web
npm run start --workspace @forms/webhook-consumer
```

Shared strict TypeScript options live in tsconfig.base.json. Node servers use
NodeNext modules; Next.js uses its bundler configuration and generated route types.
The API exports createApp(pool) separately from its listening server so tests can
use a pool and an ephemeral HTTP port. server.ts is the entry point; an index.ts
file is not required for PostgreSQL connections or migrations.

Dependencies stay focused: Express handles HTTP, Next/React render the web UI,
tsx runs TypeScript during development, concurrently starts all three processes,
and ESLint/Prettier provide linting/formatting. Existing SQL migrations remain the
schema authority. The API uses the pg driver with parameterized SQL, without a second
ORM migration system. Existing root pg/dotenv dependencies are preserved; the API
also declares pg and its types as workspace dependencies. Node loads its environment
file, so dotenv is not needed by the current server implementation.

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
Ownership and form publication locks belong to later services; this helper does
not implement those business rules.

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

Node.js is needed later for the applications. PostgreSQL does not need a separate
Windows installation: Docker Compose runs the official PostgreSQL 18 image.

## Start the database

Run these commands from the repository root in PowerShell:

```powershell
Copy-Item .env.example .env
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

See [the data model](docs/DATA-MODEL.md) for storage/contract details and the distinction
between database constraints and service rules. No assessment seed data exists yet.

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
is passed as UTF-8 to scrypt). AUTH-01 must support this format or explicitly
migrate it when implementing login; authentication endpoints are not built yet.

Version 2 replaces the old notes question with a new question, renames Engineering
to Product Engineering, and changes the scale maximum from 5 to 10. Version 1's
definitions and answers retain their own IDs. Draft questions/options have separate
stable editor IDs. Both text questions deliberately share the label "Details" to
exercise ID-based rendering and export columns.

Answer fixtures include optional blanks, repeated respondent emails, minimum and
maximum ratings, leap-day dates, multiple selected options in a different order
from the option list, Unicode, quotes, multiline text, HTML-looking text, and
`=SUM(1,2)` stored as literal text. These prepare later UI/XLSX tests; they do not
claim escaping or export functionality already exists. Invalid foreign options,
cross-version answers, and duplicates belong in rollback-only constraint tests,
not in persistent sample records.

The survey webhook is configured for `http://localhost:4001/webhooks` with sample
secret `demo-webhook-secret-local-only`. No HTTP calls or pretend delivery attempts
are made by seeding. The consumer route/secret validation comes in HOOK-02; configure
its matching secret then. This URL assumes the API and consumer run on the host.

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
