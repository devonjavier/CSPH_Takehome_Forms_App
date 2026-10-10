import { createDatabasePool, withTransaction } from "../src/database.js";
import { seedFixtures } from "./fixtures.js";

const pool = createDatabasePool();
try {
  const result = await withTransaction(pool, seedFixtures);
  console.log(
    `Assessment fixtures ${result}. See README.md for the fixture guide.`,
  );
} catch {
  console.error(
    "Seed failed and was rolled back. Check database connectivity, migrations, and conflicting demo IDs/emails/slugs. Existing data was not overwritten.",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
