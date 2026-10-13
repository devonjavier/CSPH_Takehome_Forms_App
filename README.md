# Forms App

Create forms, share a public link, collect responses and export them to Excel.
Includes a small webhook consumer to demonstrate submission notifications.

## Requirements

- Node.js 24 and npm 11
- Docker Desktop running with Docker Compose
- PowerShell for the database commands below

Run all commands from the repository root. PostgreSQL runs in Docker; the three
applications run locally through npm.

## First-time setup

### 1. Install dependencies and create configuration files

```powershell
npm ci

if (!(Test-Path .env)) { Copy-Item .env.example .env }
if (!(Test-Path apps/api/.env)) { Copy-Item apps/api/.env.example apps/api/.env }
if (!(Test-Path apps/web/.env)) { Copy-Item apps/web/.env.example apps/web/.env }
if (!(Test-Path apps/webhook-consumer/.env)) {
  Copy-Item apps/webhook-consumer/.env.example apps/webhook-consumer/.env
}
```

Edit these local files:

| File | What to set |
|---|---|
| `.env` | Choose `POSTGRES_PASSWORD` for your local database. |
| `apps/api/.env` | Set `PGPASSWORD` to the same password and set `JWT_SECRET`. Keep `WEB_ORIGIN=http://localhost:3000`. |
| `apps/web/.env` | Default `API_INTERNAL_URL=http://127.0.0.1:4000` works locally. |
| `apps/webhook-consumer/.env` | The example secret works with the sample data. |

Generate a JWT secret, then paste the result into `apps/api/.env`:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

If you change the database name, user or port in the root `.env`, update the
matching API `PG*` settings too. Keep `.env` files out of Git.

### 2. Start PostgreSQL and apply migrations

```powershell
docker compose up -d --wait
./database/migrate.ps1
```

### 3. Add sample data (optional)

```powershell
npm run seed
```

| Demo account | Password |
|---|---|
| `owner.alpha@example.test` | `FormsDemo!2026` |
| `owner.beta@example.test` | `FormsDemo!2026` |

The sample data includes four forms, all eight question types, historical
responses and a configured webhook. Re-running the seed preserves an existing
complete fixture set; it does not reset your work.

### 4. Run the apps

```powershell
npm run dev
```

| App | Address |
|---|---|
| Forms website | http://localhost:3000 |
| API health check | http://localhost:4000/health |
| Webhook consumer | http://127.0.0.1:4001 |

Use `localhost:3000` consistently for the website so cookies and the allowed
origin match. To run apps separately, use `npm run dev:web`, `npm run dev:api`
and `npm run dev:consumer` in separate terminals.

## Try the app

1. Register or sign in with a demo account.
2. Create a form, add questions and save the draft.
3. Choose **Publish changes**, confirm, and open the public link.
4. Submit a response with an email address; respondents do not need an account.
5. Return to **Your forms → View responses** to inspect answers or **Export XLSX**.

Drafts may be incomplete, but publication requires a title and valid questions.
Each publication creates a new version. Old responses retain their original
questions; an already-open older form asks the respondent to refresh before submitting.

Excel exports use a tab for each version with responses. With no responses, the
export contains headers only. Unpublishing stops public access while retaining
history. Deleting a form archives its data and removes access through the app.

## Try the webhook

1. On your form, open **Webhook**.
2. Set the URL to `http://127.0.0.1:4001/webhooks`.
3. Set the secret to the consumer's `WEBHOOK_SECRET` value. The example is
   `demo-webhook-secret-local-only`.
4. Submit the published form.
5. Open http://127.0.0.1:4001 and select **Refresh deliveries**. Check the form's
   webhook page for delivery status or errors.

The seeded survey at http://localhost:3000/f/demo-survey already has a webhook
configured. The consumer keeps its latest 50 deliveries in memory; restarting
it clears that list. Stored form responses remain in PostgreSQL.

Webhooks send JSON with `form` information and a `response` containing the email,
submission time and answers. The secret is sent in `X-Webhook-Secret`. Missing or
incorrect secrets return 401. Delivery happens after the response is saved;
a failed receiver does not fail the submission. Failed deliveries are not retried.

## Everyday commands

```powershell
# Start the database and apps again
docker compose up -d --wait
npm run dev

# Apply new migrations after pulling changes
./database/migrate.ps1

# Run tests and checks (PostgreSQL must be running)
npm test
npm run lint
npm run format:check
npm run typecheck
npm run build
```

Stop the apps with Ctrl+C. Use `docker compose stop` to stop PostgreSQL while
keeping its data. Do not remove the database volume unless you intend to erase it.

## Troubleshooting

- **API will not start:** check that Docker/PostgreSQL is running, migrations have
  been applied, API database credentials match, and `JWT_SECRET` is set.
- **Port 4000 shows `NOT_FOUND`:** this is the API, not the website. Open port 3000.
  `/health` checks the API process; `/ready` checks database connectivity.
- **Connection reset during development:** source edits restart the API and can
  interrupt requests. Dependency files are excluded from watching. Restart
  `npm run dev` after updating scripts, dependencies or environment files.
- **Webhook not received:** check that the consumer is running, its secret matches,
  and the owner webhook page shows a successful delivery.
- **Database password changed but login fails:** changing `.env` does not change
  the password inside an existing PostgreSQL volume. Use the existing password
  or change it in PostgreSQL; do not delete data to fix configuration.

This guide is for local development. Production additionally requires HTTPS,
secure environment configuration and trusted `WEBHOOK_ALLOWED_ORIGINS`.
For design decisions, payload details and code explanations, see the
[architecture walkthrough](ARCHITECTURE-WALKTHROUGH.md).
