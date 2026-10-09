# Forms App

Take-home forms application. Initial setup currently provides local PostgreSQL;
the Express API, Next.js frontend, and webhook consumer are not scaffolded yet.

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

Enter `\dt` to list tables and `\q` to exit. No application tables exist yet;
we will create them through version-controlled migrations after schema planning.

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
