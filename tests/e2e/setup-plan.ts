/**
 * Creates the end-to-end tests' study plan on the runner's throwaway database (run.ts calls it).
 * New questions on every day of the week, so the flows find a question to start whatever day
 * they run (the default plan has none on Saturday and Sunday). Weekend reviews are covered by
 * the unit tests, which simulate whole weeks.
 */
import os from "node:os";
import path from "node:path";

const dir = process.env.LCC_DATA_DIR ? path.resolve(process.env.LCC_DATA_DIR) : "";
// Only ever a temporary directory made by the runner, never real or demo data.
if (!dir?.startsWith(path.resolve(os.tmpdir())) || !path.basename(dir).startsWith("lcc-e2e-data-") || process.env.LCC_DB_PATH) {
  throw new Error("setup-plan only runs on the e2e runner's temporary data directory");
}

async function main() {
  const { createPlan, getActivePlan, openDb } = await import("@lcc/db");
  const db = openDb();
  if (!getActivePlan(db)) createPlan(db, { settings: { newPerWeekday: [5, 5, 5, 5, 5, 5, 5] } });
  console.log("E2E plan ready: 5 new questions every day");
  db.$client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
