/**
 * Generates a realistic 5-week practice history in a SEPARATE data directory so
 * you can explore the dashboard without touching your real data:
 *   npm run demo            (writes data/demo, then: npm run dev:demo)
 * It drives the same services the app uses (scheduler, sessions, submissions).
 */
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.env.LCC_DATA_DIR ?? "data/demo");
if (path.basename(dir) !== "demo") throw new Error("Refusing to write demo data outside a *demo* directory");
fs.rmSync(dir, { recursive: true, force: true });
process.env.LCC_DATA_DIR = dir;

async function main() {
  const db = await import("@lcc/db");
  const { addDays, localDateBounds, startOfWeek, toLocalDate } = await import("@lcc/shared");
  const d = db.openDb();
  db.importStudyLists(d, db.sampleLists());
  const tz = db.getAppSettings(d).timeZone;
  const today = toLocalDate(Date.now(), tz);
  const start = addDays(startOfWeek(today), -35);
  db.createPlan(d, { name: "Interview prep", startDate: start, timeZone: tz }, localDateBounds(start, tz).start + 8 * 3_600_000);

  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T,>(xs: T[], ws: number[]) => {
    let r = rnd() * ws.reduce((a, b) => a + b, 0);
    for (let i = 0; i < xs.length; i++) if ((r -= ws[i]!) <= 0) return xs[i]!;
    return xs[xs.length - 1]!;
  };
  const at = (date: string, h: number, m = 0) => localDateBounds(date, tz).start + h * 3_600_000 + m * 60_000;
  const notesBank = ["Two pointers from both ends.", "Hash map of seen values → index.", "Sliding window, shrink while invalid.", "Monotonic stack keeps candidates.", "BFS level by level.", "DP over prefix; dp[i] depends on i-1, i-2."];
  const mistakesBank = ["Off-by-one on the right boundary", "Forgot the empty input case", "Didn't skip duplicates", "Integer overflow in mid computation", "Mutated input while iterating"];
  let subId = 700000000;

  for (let day = 0; day < 35; day++) {
    const date = addDays(start, day);
    if (rnd() < 0.08) continue; // missed day
    const view = db.getTodayView(d, at(date, 8));
    const items = [...view.sections.newQuestions, ...view.sections.mandatory, ...view.sections.srs].filter((i) => i.assignment.status === "pending");
    let minute = 0;
    for (const it of items) {
      if (rnd() < 0.1) continue; // leave some unfinished (carry-over)
      const t0 = at(date, 18, minute);
      const { session } = db.startSession(d, { problemId: it.problem.id, assignmentId: it.assignment.id, origin: "dashboard", startedAt: t0 }, t0);
      const review = it.assignment.type !== "new";
      const skill = review ? 0.75 : 0.45;
      const outcome = pick(["easy", "independent", "struggled", "hints", "failed"] as const, review ? [3, 5, 2, 1, 0.3] : [1, 3, 3, 2, 0.6]);
      const dur = Math.round((review ? 9 : 22) * (0.6 + rnd()) * (outcome === "easy" ? 0.6 : outcome === "failed" ? 1.5 : 1));
      const attempts = outcome === "failed" ? 2 : outcome === "easy" ? 1 : 1 + Math.floor(rnd() * (2 / skill));
      for (let k = 0; k < attempts; k++) {
        const last = k === attempts - 1;
        const verdict = last && outcome !== "failed" ? "Accepted" : pick(["Wrong Answer", "Time Limit Exceeded", "Runtime Error"] as const, [5, 2, 1]);
        const at2 = t0 + Math.round(((k + 1) / attempts) * dur * 60_000);
        const code = `class Solution:\n    def solve(self, nums):\n        # attempt ${k + 1}\n        seen = {}\n        for i, x in enumerate(nums):\n            if x in seen:\n                return [seen[x], i]\n${last ? "            seen[target - x] = i\n" : "            seen[x] = i\n"}        return []\n`;
        const { submission } = db.recordSubmission(d, { problemId: it.problem.id, claimedSessionId: session.id, kind: "submit", platformSubmissionId: String(subId++), lang: "python3", code, submittedAt: at2, captureSource: "extension_network" });
        db.applyJudgeResult(d, { problemId: it.problem.id, claimedSessionId: session.id, kind: "submit", platformSubmissionId: submission.platformSubmissionId!, verdict, statusCode: verdict === "Accepted" ? 10 : 11, runtime: verdict === "Accepted" ? `${1 + Math.floor(rnd() * 60)} ms` : null, memory: "17.4 MB", totalCorrect: verdict === "Accepted" ? 50 : 20, totalTestcases: 50, lang: "python3", judgedAt: at2 + 2000 });
      }
      db.recordActivity(d, session.id, Math.round(dur * 60_000 * 0.85), t0 + dur * 60_000);
      db.finishSession(
        d,
        session.id,
        {
          outcome,
          hintsUsed: outcome === "hints",
          notes: rnd() < 0.7 ? notesBank[Math.floor(rnd() * notesBank.length)] : null,
          mistakes: outcome !== "easy" && rnd() < 0.5 ? mistakesBank[Math.floor(rnd() * mistakesBank.length)] : null,
        },
        t0 + dur * 60_000 + 30_000,
      );
      if (!review && rnd() < 0.4) db.saveNotes(d, it.problem.id, { insight: notesBank[Math.floor(rnd() * notesBank.length)]!, timeComplexity: "O(n)", spaceComplexity: "O(n)" });
      minute += dur + 3;
    }
  }
  db.getTodayView(d); // materialize today
  console.log(`Demo data written to ${dir}. Start it with: npm run dev:demo`);
  d.$client.close();
}

void main();
