import { Pool, types, type PoolClient } from "pg";

// A calendar date is not an instant. Keep DATE values as YYYY-MM-DD strings.
types.setTypeParser(types.builtins.DATE, (value) => value);

export function createDatabasePool(

  environment: NodeJS.ProcessEnv = process.env,
): Pool {
  const { PGUSER, PGDATABASE, PGPASSWORD } = environment;

  if (!PGUSER || !PGDATABASE || !PGPASSWORD) {
    throw new Error(
      "Set PGUSER, PGDATABASE, and PGPASSWORD in the API server environment.",
    );
  }

  const port = Number(environment.PGPORT ?? "5432");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PGPORT must be an integer between 1 and 65535.");
  }

  const pool = new Pool({
    host: environment.PGHOST ?? "127.0.0.1",
    port,
    user: PGUSER,
    database: PGDATABASE,
    password: PGPASSWORD,
    max: 10,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 10000,
    statement_timeout: 5000,
    idle_in_transaction_session_timeout: 10000,
    application_name: "forms-api",
  });
  
  // pg emits errors for idle connections too. Never log credentials or raw SQL.
  pool.on("error", () =>
    console.error("An idle database connection was lost."),
  );
  return pool;
}

export async function withTransaction<Result>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  let discardConnection = false;
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    const commit = await client.query("COMMIT");
    // PostgreSQL reports ROLLBACK if a callback swallowed an earlier SQL error.
    if (commit.command !== "COMMIT") {
      throw new Error("The transaction was aborted and could not commit.");
    }
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      discardConnection = true;
    }
    throw error;
  } finally {
    // Every statement in the callback must use this client, never pool.query.
    client.release(discardConnection);
  }
}
