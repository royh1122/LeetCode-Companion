import path from "node:path";

/**
 * For e2e files that open the database directly. Run on their own, without LCC_DATA_DIR,
 * they would open the repo's data/ folder: the real database. Refuse that.
 */
export function requireIsolatedDataDir(script: string) {
  const dir = process.env.LCC_DATA_DIR ? path.resolve(process.env.LCC_DATA_DIR) : "";
  const real = path.resolve(import.meta.dirname ?? __dirname, "..", "..", "data");
  if (!dir || path.relative(dir, real) === "" || process.env.LCC_DB_PATH) {
    throw new Error(`${script} needs LCC_DATA_DIR set to a test folder (e.g. data/e2e), not the real data folder, and no LCC_DB_PATH. Or run it through npm run test:e2e.`);
  }
}
