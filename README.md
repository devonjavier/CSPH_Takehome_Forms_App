# Forms App

Take-home forms application. Local PostgreSQL and the initial relational schema
are implemented. The Express API, Next.js frontend, and webhook consumer are not
scaffolded yet.

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
```

The migration runner applies numbered SQL files from `database/migrations` in a
transaction using the container's `psql`. It reads credentials from the container's
environment without printing them. `schema_migrations` records applied filenames
and SHA-256 checksums. Repeating the command skips applied files; changing an applied
file fails. Add a new numbered migration for future schema changes. Existing tables
with conflicting names fail instead of being overwritten. There is no reset command.

The tests insert temporary fixtures inside a transaction, exercise constraints in
real PostgreSQL, and roll back. They cover all eight answer storage types, version
and option membership, duplicate selections/answers, immutable definition updates,
and retention after archival. They are not API/authentication or concurrency tests.

See [the data model](docs/DATA-MODEL.md) for storage/contract details and the distinction
between database constraints and service rules. No assessment seed data exists yet.

## GitHub Actions migration checks

`.github/workflows/migrate.yaml` runs when `database/**`, the workflow, or
`docker-compose.yml` changes on pushes to develop/main or pull requests targeting
those branches. Manual dispatch is also configured (GitHub requires the workflow
on the default branch for the manual-run UI).

Each run uses an isolated PostgreSQL 18 service: apply migrations to a fresh database,
apply again to verify replay, then run the rollback-only constraint tests. CI uses
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
CI does not prove an upgrade preserves real data or detect edits to older migrations
across commits; the ledger detects drift when run against an already-migrated database.
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

## Planned application layout

```text
apps/api                 Express + TypeScript
apps/web                 Next.js + TypeScript
apps/webhook-consumer    Minimal webhook receiver and list view
```

The applications will initially run on Windows while PostgreSQL runs in Docker.
The API connects to PostgreSQL; the browser never receives database credentials.
