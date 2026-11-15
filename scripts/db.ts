/**
 * Database CLI: migrate | sample | backup | restore <file> | export [file] | import <file>
 * Run via npm scripts, e.g. `npm run db:backup`.
 */
import fs from "node:fs";
import path from "node:path";
import { backupDatabase, backupDir, checkDatabaseFile, dataDir, defaultDbPath, exportAll, importAll, importStudyLists, openDb, sampleLists } from "@lcc/db";

/** The ports a dashboard on this database could be using: the usual one, and LCC_PORT if set. */
const dashboardPorts = () => [...new Set([4317, Number(process.env.LCC_PORT) || 4317])];
const answers = (port: number) => fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "migrate": {
      const db = openDb();
      console.log(`Database ready: ${defaultDbPath()}`);
      db.$client.close();
      break;
    }
    case "sample": {
      // Made-up lists, for end-to-end runs on a throwaway database.
      const db = openDb();
      console.log(importStudyLists(db, sampleLists()));
      db.$client.close();
      break;
    }
    case "backup": {
      const db = openDb();
      const file = await backupDatabase(db.$client, "manual");
      console.log(`Backup written: ${file}`);
      db.$client.close();
      break;
    }
    case "restore": {
      if (!arg) {
        const files = fs.existsSync(backupDir()) ? fs.readdirSync(backupDir()).filter((f) => f.endsWith(".db")).sort() : [];
        console.log("Usage: npm run db:restore -- <backup-file>\nAvailable backups:\n" + files.map((f) => `  ${path.join(backupDir(), f)}`).join("\n"));
        process.exit(1);
      }
      const src = path.resolve(arg);
      if (!fs.existsSync(src)) throw new Error(`No such file: ${src}`);
      // Validate the backup opens, is intact and looks like ours.
      const problem = checkDatabaseFile(src);
      if (problem) throw new Error(problem);
      const target = defaultDbPath();
      if (src === path.resolve(target)) throw new Error("That is the live database, not a backup. Pick a file from data/backups.");
      // Replacing the file under a running server loses the restore (or fails half-way on Windows).
      for (const port of dashboardPorts()) {
        if (await answers(port)) throw new Error(`A dashboard is running on port ${port}. Stop it first (npm run down), then restore.`);
      }
      if (fs.existsSync(target)) {
        const cur = openDb(target, { migrate: false });
        const safety = await backupDatabase(cur.$client, "before-restore");
        cur.$client.close();
        console.log(`Current database saved to ${safety}`);
        for (const ext of ["", "-wal", "-shm"]) fs.rmSync(target + ext, { force: true });
      }
      fs.copyFileSync(src, target);
      openDb(target).$client.close(); // apply any newer migrations
      console.log(`Restored ${src} → ${target}. Restart the dashboard.`);
      break;
    }
    case "export": {
      const db = openDb();
      const out = arg ? path.resolve(arg) : path.join(dataDir(), "exports", `leetcode-companion-${new Date().toISOString().slice(0, 10)}.json`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(exportAll(db), null, 2));
      console.log(`Exported to ${out}`);
      db.$client.close();
      break;
    }
    case "import": {
      if (!arg) throw new Error("Usage: npm run db:import -- <export.json>");
      const db = openDb();
      await backupDatabase(db.$client, "pre-import");
      const report = importAll(db, JSON.parse(fs.readFileSync(path.resolve(arg), "utf8")));
      console.log(JSON.stringify(report, null, 2));
      db.$client.close();
      break;
    }
    default:
      console.log("Commands: migrate | sample | backup | restore <file> | export [file] | import <file>");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
