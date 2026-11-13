# Architecture

```text
leetcode-prep/
├── apps/
│   ├── web/          Next.js 16 dashboard (App Router, server components + server actions, Tailwind v4)
│   └── extension/    Chrome MV3 extension (esbuild): service worker, content scripts, side panel, options
├── packages/
│   ├── shared/       Zod schemas, enums, date and duration rules, LeetCode URL/verdict parsing (used by both apps)
│   ├── scheduler/    Pure scheduling, SRS and mastery logic
│   └── db/           Drizzle schema + migrations (SQLite / better-sqlite3), services, sync, import/export, backups;
│                     lists/ holds redistributable question lists (each names its source and licence)
├── scripts/          up/down launchers, db CLI (migrate/backup/restore/export/import), Windows shortcuts, demo data generator
├── tests/e2e/        Playwright flows (dashboard UI, extension) + runner
└── docs/
```

Business rules live in exactly one place. The extension imports URL and verdict parsing from `@lcc/shared/leetcode`. The server validates every incoming event with the same Zod schemas (`@lcc/shared/events`). Scheduling never runs in the browser.

## Data model (SQLite)

| Table | Purpose |
|---|---|
| `problems` | One row per LeetCode problem. Unique on `(platform, slug)`, and on `(platform, platform_question_id)` when known. Holds topics and editable study patterns. |
| `study_lists`, `study_list_problems` | Curated lists with their own ordering and group names (many-to-many). |
| `study_plans` | Settings (JSON, validated by `planSettingsSchema`), start date, time zone, active/paused/archived. |
| `plan_queue` | Ordered problems the plan introduces as new: pending / assigned / done / skipped as practiced / removed. |
| `plan_skips`, `plan_light_days`, `plan_days` | Skipped days; light days (fewer new questions, no automatic reviews); records that a day's allocation already ran (idempotency). |
| `assignments` | Planned tasks. Partial unique indexes: one *open* task per (problem, type); one weekend review per (problem, cohort week). |
| `sessions` | Every attempt (UUID, which the extension can create offline): timing (started/ended, paused time, extension active time, manual override), reflection, reveals, recommended vs. chosen next review. Partial unique index: one open session per problem. |
| `submissions` | Code versions + judge results. Unique on platform id; unique fingerprint fallback. `kind` = submit or run. `attribution` = bound / inferred / manual / none. |
| `problem_notes`, `problem_note_revisions` | Permanent concept notes (structured fields) plus previous versions. |
| `review_state` | Derived SRS state per problem (re-computable from sessions). |
| `sync_events` | Every extension event, processed at most once; status and error kept for debugging. |
| `daily_snapshots` | Backlog and mastery per day for trend charts. |
| `app_meta` | Settings, pairing token, revision counter, session aliases. |

- Foreign keys are enforced. Problems can't be deleted while referenced, and deleting a plan sets `assignments.plan_id` to null, so history survives.
- Multi-row operations run in transactions (nested ones use savepoints).
- WAL mode is on, so the CLI can read while the server runs.

## Dashboard

- Pages are server components that read SQLite directly through `@lcc/db`. They are always dynamic, never cached.
- Mutations are server actions (`apps/web/src/lib/actions.ts`); Next.js checks their origin.
- **Live updates:** a tiny client component polls `/api/revision`, a counter bumped by every write, every 3 seconds and calls `router.refresh()` when it changes. That's how extension captures appear without reloading. Client-side state such as half-typed notes survives the refresh.
- Autosave fields save after 800 ms idle and on blur. They show *Saving… / Saved / Not saved — retrying* and warn before unload while dirty.

## Extension

```text
LeetCode page ──(MAIN world: fetch/XHR observer)──postMessage──▶ isolated content script
     ▲                                                              │ chrome.runtime.sendMessage
     └──── overlay (closed Shadow DOM) ◀── tab:state ── service worker (Controller) ──HTTP──▶ dashboard /api/ext/*
                                                             ▲
                                              side panel / options (chrome.runtime messages)
```

- `Controller` (`apps/extension/src/lib/controller.ts`) holds all logic.
  - Every operation runs under a promise mutex and reads and writes `chrome.storage`. A killed service worker loses nothing.
  - `chrome.storage.local` holds config, the event queue, local sessions and pending checks.
  - `chrome.storage.session` holds tab bindings and pending study-plan offers, which are only valid for one browser run.
- **Queue**
  - Events carry a UUID and a sequence number and are flushed in order, in batches of 50.
  - Cumulative events (activity, notes) are coalesced.
  - A network or server error keeps the batch for retry: on every action, on `chrome.alarms` every 30 s, and on **Sync now**.
  - `rejected` results move to a failed list that is visible in the panel.
  - If the server keeps failing on a batch (not when it's merely offline), events are retried one at a time, and one that still fails is moved to the failed list so the rest can sync.
- **Reconciliation:** every 30 s, open local sessions are checked against the server. A session finished or abandoned in the dashboard unbinds its tabs.
- **Session start paths**
  1. Dashboard **Start**: the server creates the session, then the tab opens with `#lcc-session=<id>` and the extension binds to it.
  2. A direct visit gets an offer (start, resume, history or ignore), shown in the page and in the panel.
  3. A second tab on the same problem auto-shares the open session.
  4. After a browser restart, the extension offers to resume.

## Testing

| Layer | Where | How |
|---|---|---|
| Scheduler | `packages/scheduler/test` | Pure unit tests |
| Database / services | `packages/db/test` | In-memory SQLite with real migrations and made-up sample lists (`sampleLists()`); full simulated weeks |
| Extension logic | `apps/extension/test` | Controller with in-memory storage and a fake API; LeetCode-shaped fixtures |
| Dashboard E2E | `tests/e2e/ui-flow.ts` | Playwright against the running app |
| Extension E2E | `tests/e2e/extension-flow.ts` | Built extension in Chromium + real dashboard + stub LeetCode at real URLs, including study-plan pickup |
| Security boundary | `tests/e2e/boundary.ts` | Plain HTTP checks of Host, Origin, cross-site, token and header rules against the dashboard the E2E run starts |
