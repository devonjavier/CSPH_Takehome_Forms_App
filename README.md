# Forms App

Take-home forms application. Local PostgreSQL, the initial relational schema, and
three runnable application scaffolds are implemented. Authentication, form building,
submissions, export, and webhook delivery are subsequent tickets.

## Run the applications

Use Node.js 24 and npm 11. This repository uses npm workspaces with one root
package-lock.json; run installs from the repository root.

```powershell
npm ci
npm run dev
```

| App | Address | Current behavior |
|---|---|---|
| Next.js web | http://localhost:3000 | Responsive placeholder home page |
| Express API | http://localhost:4000/health | JSON liveness response |
| Webhook consumer | http://localhost:4001 | Placeholder page; /health returns JSON |

Press Ctrl+C to stop the development apps. You can instead run one app with
`npm run dev:web`, `npm run dev:api`, or `npm run dev:consumer`.

The apps currently start without PostgreSQL. The API health response is only process
liveness, not a database readiness check. DB-02 will add the connection lifecycle.
The consumer does not yet accept POSTs or receive payloads; HOOK-02 implements that.

Root `.env` remains Docker Compose configuration. The API and consumer optionally
load their own `apps/<name>/.env` via Node's environment-file support; copy their
`.env.example` if overriding PORT. Neither reads root `.env`. No database credentials
are passed to Next.js or exposed using NEXT_PUBLIC_. No app env file is required yet.

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
The API exports the Express app separately from its listening server so later tests
can import it without opening a fixed port.

Dependencies stay focused: Express handles HTTP, Next/React render the web UI,
tsx runs TypeScript during development, concurrently starts all three processes,
and ESLint/Prettier provide linting/formatting. Existing SQL migrations remain the
schema authority. For DB-02, use the pg driver with parameterized SQL rather than
introducing a second ORM migration system; the driver is not installed in APP-01.

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
