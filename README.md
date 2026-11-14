# LeetCode Companion

A local-first study dashboard for working through LeetCode question lists you choose. It plans each day's questions, tracks every attempt as its own session, and captures your LeetCode submissions (code + verdict) through a Chrome extension. Over time it builds a searchable history of how your solving improves.

You keep solving on LeetCode. The dashboard handles everything around it:

- **Today**: new questions, mandatory weekend reviews and spaced-repetition reviews, shown in three separate sections.
- **Sessions**: each attempt gets its own timer, notes, submissions, reflection and next-review decision. A problem is never "done forever."
- **Extension**: detects the problem you're on, binds the tab to your session, captures Submit/Run results, and lets you take notes and finish from a side panel.
- **History and analytics**: per-question timelines, code diffs between attempts, topic breakdowns, mastery, and backlog trends.

> Problem ≠ Session ≠ Submission. A *problem* is one LeetCode question, with one permanent record however many lists contain it. A *session* is one sitting spent solving or reviewing it. A *submission* is one code version judged by LeetCode.

This is an independent, open-source personal tool. It is not affiliated with or endorsed by LeetCode.

**Privacy.** Everything stays on your computer. The dashboard listens only on `127.0.0.1`, your code and notes live in a local SQLite file, and nothing is sent to any third party. The extension only observes what your own LeetCode page already loads; it never sends requests to LeetCode, stores no password, and talks only to your local dashboard. You are responsible for using it within LeetCode's terms of service.

Third-party material is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## Requirements

- Node.js 22.12 or later. Developed on Node 26.
- Google Chrome 120 or later, for the extension.
- Developed and tested on Windows. macOS and Linux should work through `npm run up` / `npm run down`, but haven't been tested. The desktop shortcuts are Windows-only.

## Setup

```bash
git clone https://github.com/royh1122/LeetCode-Companion.git
cd LeetCode-Companion
npm install
npm run db:migrate       # creates data/leetcode-companion.db (empty)
```

The repo's `.npmrc` turns off package install scripts. That's deliberate: the SQLite driver ships ready-made binaries, and without it npm tries to compile it from source, which fails on machines without C++ build tools.

### Run the dashboard

```bash
npm run up               # start (rebuilds only if the code changed) and open http://127.0.0.1:4317
npm run down             # stop it
```

**On Windows, use shortcuts.** Run `npm run shortcuts` once. It creates **LeetCode Companion** and **Stop LeetCode Companion** on your Desktop and in the Start menu.
- **Starting:** double-click **LeetCode Companion**. The server starts invisibly in the background, with no window or taskbar entry, and the dashboard opens in your browser when it's ready. If the server is already running, it just opens the dashboard.
- **Updates:** if the code was updated, a small notice says it's rebuilding, which takes about a minute.
- **Stopping:** double-click **Stop LeetCode Companion**. The server also stops when you shut down or sign out.
- **Logs:** the server writes to `data/server.log` (the previous run is in `data/server.prev.log`), and the launcher writes to `data/launcher.log`. If starting fails, a message points you to these files.
- **Maintenance:** run `npm run shortcuts` again if you move the project folder, or `npm run shortcuts -- --remove` to delete the shortcuts.

From a terminal, `npm run up` runs the server in that terminal (Ctrl+C stops it). `npm run up -- --background` runs it in the background, like the shortcut.

`npm run up` also rebuilds the extension when its code changed, and then tells you to reload it in `chrome://extensions`. `npm run app` still works, but it always does a full rebuild. For development with hot reload, use `npm run dev`.

**Another port.** If port 4317 is taken, set `LCC_PORT` for both `up` and `down` (for example `LCC_PORT=4320 npm run up` in bash, or `$env:LCC_PORT=4320; npm run up` in PowerShell), and put the same URL (`http://127.0.0.1:4320`) in the extension's options.

### Import a question list

Open http://127.0.0.1:4317. The first screen asks you to import a question list. There are three ways:

1. **A ready-made list.** One ships with the app: the Tech Interview Handbook's 5-week list (61 questions, by the author of Blind 75, MIT licence). Only lists whose licence allows redistribution are bundled; they live in `packages/db/lists`, each with its source and licence.
2. **A LeetCode study plan, through the extension.** LeetCode's own lists (LeetCode 75, Top Interview 150, …) can't be bundled. Open one at `leetcode.com/studyplan/…` with the extension installed and the side panel offers **Import into dashboard**. The extension reads the question list the page itself loads (its own GraphQL response, or the data embedded in the page on a full load); it sends no request to LeetCode, and nothing reaches the dashboard until you click Import.
3. **Paste your own.** Give it a name and paste either:

   - **Links or slugs**, one per line, in the order you want to study them. A line starting with `#` names a group, which becomes the questions' pattern:

  ```
  # Arrays
  https://leetcode.com/problems/two-sum/
  valid-anagram
  ```

  Questions imported this way start with a title made from the slug and no difficulty. The extension fills in the real title and number when you start a session on the problem or it captures a submission. Difficulty stays blank unless a list provides it (study-plan JSON and LeetCode study plans do).
   - **Study-plan JSON** in the shape `{ "name", "planSubGroups": [{ "name", "questions": [{ "titleSlug", "title", "difficulty", … }] }] }`, either bare or wrapped as `{ "data": { "studyPlanV2Detail": … } }`. Only `titleSlug` is required per question.

Import more lists any time from **Question library → Import a question list**, then add them to your plan under **Study plan → List order**. Importing under the name of an existing list replaces that list's questions; if your plan already uses the list, new questions join the end of the queue. Importing a list only fills in problem details that are missing, and never touches your history.

### Create a plan

Click **Create study plan**. Everything can be changed later under *Study plan*. The defaults:

| Day | Default |
|---|---|
| Mon–Fri | 5 new questions |
| Sat | Mandatory review of 12 questions from this week's cohort |
| Sun | Mandatory review of the rest of the cohort |
| Daily | Up to 5 spaced-repetition reviews (3 on review days) |

### Install the Chrome extension

```bash
npm run ext:build        # → apps/extension/dist
```

1. Go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick `apps/extension/dist`.
2. The options page opens. Keep the dashboard URL as `http://127.0.0.1:4317`.
3. In the dashboard, go to **Settings → Browser extension**, copy the pairing token, and paste it into the extension's options. Then click **Save & test connection**.
4. Pin the extension. Clicking its icon opens the side panel.

After changing extension code, run `npm run ext:build` again and click reload on the extension's card in `chrome://extensions`.

**What the extension's permissions are for:**
- **Read and change data on leetcode.com:** a script on LeetCode pages observes the page's own Submit/Run/verdict requests and, on study-plan pages, the plan's question list. It doesn't change the page's requests or send any of its own.
- **127.0.0.1 / localhost:** talking to your dashboard. The options page only accepts a dashboard address on this computer.
- **storage:** settings, the pairing token, and changes waiting to sync.
- **sidePanel:** the side panel.
- **alarms:** syncing every 30 seconds.

## Daily workflow

1. Open the dashboard. **Today** lists your questions.
2. Click **Start** (or **Review**). This creates a session, opens the problem on LeetCode in a reused tab, and shows the session workspace in the dashboard.
3. Solve on LeetCode as usual. Each **Submit** is captured with its code and verdict and appears in the side panel and the dashboard within a second or two. **Run** results are stored separately and never counted as submissions.
4. In the side panel (or the dashboard session page), pick how it went (keys **1–5**), add a one-line note, and click **Finish**. The recommended next-review date is shown, and you can override it.
5. Go back to Today for the next question.

**Without the extension**, everything still works from the dashboard. The session page has a timer, pause/resume, notes, outcome, and **Log a submission manually**. You can also add a past attempt from any question page.

**Opening LeetCode directly** also works. The extension recognizes the problem and offers *Start session*, *Resume*, *History* or *Ignore*. Refreshing the page or opening a second tab never creates a duplicate session.

**Review mode.** For problems you've practiced before, previous notes, code and hints are hidden until you click *Reveal*. Each reveal is recorded and pre-ticks "used hints."

## Commands

| Command | What it does |
|---|---|
| `npm run up` / `npm run down` | Start the dashboard (build only if needed, open the browser; add `-- --background` to run it hidden) / stop it |
| `npm run shortcuts` | Windows: create Start/Stop shortcuts on the Desktop and in the Start menu |
| `npm run dev` | Dashboard with hot reload (port 4317) |
| `npm run app` | Build and run the production dashboard (port 4317) |
| `npm run ext:build` / `ext:watch` | Build the extension once / on change |
| `npm test` | Unit and integration tests (scheduler, database, extension logic) |
| `npm run test:e2e` | End-to-end: starts a dashboard on a temporary database, checks the local security boundary, and runs the UI flow and the extension flow in Chromium. It uses its own port (4327, or `LCC_E2E_PORT`), so the dashboard on 4317 can keep running; it refuses to run if the test port is taken. Needs Playwright's Chromium once: `npx playwright install chromium`. Add `-- --real-leetcode` to also load a real leetcode.com page. |
| `npm run typecheck` | Strict TypeScript across all packages |
| `npm run demo` then `npm run dev:demo` | Generates 5 weeks of fake history in `data/demo` and serves it on port **4318**. Your real data is untouched. |
| `npm run db:migrate` | Apply schema migrations. Takes an automatic backup first if anything is pending. |
| `npm run db:backup` | Consistent SQLite snapshot → `data/backups/` |
| `npm run db:restore -- <file>` | Restore a backup. Stop the dashboard first (it checks that nothing answers on port 4317). The current DB is backed up before it's replaced. |
| `npm run db:export [-- file]` / `db:import -- <file>` | Portable JSON export / merge import |

## Your data, backups and restore

- Everything lives in `data/leetcode-companion.db` (SQLite, WAL mode). Override the location with `LCC_DATA_DIR` or `LCC_DB_PATH`.
- **Backups.** Use **Settings → Back up database now** or `npm run db:backup`. A backup is also taken automatically before every schema migration and every JSON import.
- **Restore.** Stop the dashboard, run `npm run db:restore` with no argument to list backups, then run `npm run db:restore -- data/backups/<file>.db`.
- **JSON export/import.** Use **Settings → Export JSON** (or `npm run db:export`). Problems are referenced by slug, so an export works in any installation. Import *merges* and never overwrites:
  - sessions and submissions that already exist are skipped;
  - a note that differs from yours is kept as a note revision, so both texts survive;
  - plans are only imported into a database that has none.
- **Upgrades.** Schema changes ship as Drizzle migrations in `packages/db/drizzle`. They're applied on start with a pre-migration backup. The app never deletes history on its own.
- **Backups are never pruned.** They contain your code and notes; delete old ones in `data/backups/` by hand when you want the space back.

## Updating

```bash
git pull
npm install
npm run down && npm run up    # restarts the dashboard; `up` rebuilds when the code changed
npm run ext:build
```

Then click reload on the extension's card in `chrome://extensions` and refresh your LeetCode tabs. If an update changes the database, a backup is taken automatically on start; `npm run db:restore` undoes it.

## Uninstalling

1. Remove the extension in `chrome://extensions` (this also deletes any changes it hadn't synced yet).
2. Run `npm run down`, and on Windows `npm run shortcuts -- --remove`.
3. Delete the project folder. Your history is in `data/leetcode-companion.db` and `data/backups/`; export or copy it first if you want to keep it.

## Editing and deleting history

- **Edit** a finished session from its question page or its session page. You can change the rating ("how it went"), whether you used hints, difficulty felt, notes, mistakes, takeaway and duration. Changing the rating re-calculates that session's next-review date and the problem's schedule.
- **Delete a submission.** Expand it and click **Delete submission** (or **Delete run**). The session's "first Accepted" time is re-calculated.
- **Delete a session**, for example a test run, with **Delete**. This permanently removes the session and its submissions.
  - If the session completed a planned task, the task goes back to open. A past spaced-repetition pick expires instead, and the problem is simply due again.
  - The problem's review state and mastery are re-calculated from the sessions that remain.
  - Only finished or abandoned sessions can be deleted; abandon an open one first.
- A database backup (`data/backups/…-pre-delete-*.db`) is taken before every delete. To undo one, use `npm run db:restore`.

## What is verified vs. assumed

**Verified by automated tests (unit/integration tests plus end-to-end flows):**
- Weekly allocation (5×5 new, 12 + 13 weekend review); a skipped Saturday is caught up on Sunday.
- Missed days and carry-over without runaway catch-up; skip-day keeps your place; paused plans; time-zone boundaries.
- Weekly target: "Do more today" lightens the next study day (and makes up a missed day first), "Today, as new" counts the same way, rescheduled questions take a slot, light and skipped days ahead, reviews done up to 2 days early.
- List import (links, slugs and study-plan JSON) and overlapping lists: there's one record per problem, and already-practiced overlaps don't consume new-question quota.
- Duplicate-review prevention and SRS intervals and growth.
- Session lifecycle; history is preserved across repeat attempts.
- Submission dedup and attribution (bound / inferred / unlinked → manual link).
- Idempotent sync and offline session aliasing; export/import round trip.
- Dashboard E2E: create a plan → start practice (opens a LeetCode tab tagged with the session) → autosaved notes → manual submission → finish via keyboard → Today and the question page update, history lists it, and the other pages render.
- Extension E2E with the **real built extension in Chromium** against the real dashboard, using a stand-in LeetCode page served at real `leetcode.com/problems/...` URLs that issues the same Submit/Run/check requests:
  - pairing works, and a bad token is rejected;
  - the tab binds to the dashboard session;
  - WA then Accepted are captured with separate code versions, and the Run (made via XHR) is stored separately;
  - the dashboard updates live;
  - a refresh or a second tab doesn't create a duplicate session;
  - while offline, events are queued with an honest status, then synced exactly once on reconnect;
  - finishing from the side panel works;
  - a direct visit gets the offer, and a session can be started from the panel;
  - a study-plan page (reached by in-app navigation, or loaded directly) offers its list, and importing it adds the questions;
  - forged page messages (verdicts for submissions it never saw, submits for another problem) are ignored (unit tests).
- Security boundary, checked over plain HTTP against the dashboard the E2E run starts (the dev server, which uses the same `proxy.ts` and headers as production):
  - a foreign `Host` header returns 403 (DNS rebinding);
  - cross-site or other-origin API calls return 403;
  - extension endpoints without the right token return 401, and a web origin or CORS preflight is refused;
  - no CORS headers are sent, and `X-Frame-Options: DENY` is set.

**Not verified, and needs a manual check by you:**
- **Capture on your real, logged-in LeetCode account.** The automated tests use a stand-in page, because the automated browser gets Cloudflare's bot challenge on leetcode.com. On a real account, Submit capture has been confirmed by hand for Wrong Answer and Accepted results; Run capture and other verdicts have not. LeetCode can change its page at any time. **First-run check:** submit any problem once with the side panel open and confirm the verdict appears. If it doesn't, the panel may show "Capture unavailable" (the page hook didn't load) or simply show nothing (LeetCode changed its requests); either way you can log manually (see [docs/LEETCODE_INTEGRATION.md](docs/LEETCODE_INTEGRATION.md)).
- Active-time accuracy is an estimate (see the doc). Chrome's real side-panel window was exercised as a regular extension page, not the docked panel.

More detail: [Architecture](docs/ARCHITECTURE.md) · [Scheduling policy](docs/SCHEDULING.md) · [LeetCode integration & limitations](docs/LEETCODE_INTEGRATION.md)

## Troubleshooting

- **Side panel says "Not paired" or "token rejected".** Copy the token again from Settings and paste it into the extension options. If you rotated the token, you must re-pair.
- **"Dashboard unreachable — n change(s) queued".** Start the dashboard. Queued events sync automatically every 30 s, or immediately when you click **Sync now**.
- **"Capture unavailable on this page".** Reload the LeetCode tab after installing or reloading the extension.
- **Submissions don't appear, but there's no "Capture unavailable".** LeetCode may have changed its requests. Log submissions manually, and see the integration doc.
- **No "Import into dashboard" card on a study plan.** It appears only on `leetcode.com/studyplan/<plan>/` with the extension paired. Reload the extension, then reload the page. Plans you can't open on LeetCode (e.g. premium-only) have no list to read.
- **Import errors.** "Line N is not a LeetCode problem link or slug" means that line isn't a `leetcode.com/problems/…` link or a slug like `two-sum`. "That JSON is not a study list" means the JSON doesn't have `name` and `planSubGroups[].questions[].titleSlug`. A list can have at most 3000 questions.
- **Port 4317 in use.** Stop the other process, or use another port (see *Another port* above). The extension's dashboard URL must match.
- **`npm install` fails with node-gyp / Visual Studio errors.** Make sure you're installing from the repo folder, so its `.npmrc` applies, or run `npm install --ignore-scripts`.

## License

[MIT](LICENSE)
