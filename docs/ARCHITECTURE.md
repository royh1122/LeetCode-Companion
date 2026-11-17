# Architecture

```text
LeetCode-Companion/
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
| `sync_events` | Every extension event, processed at most once; status, error and the sending device kept for debugging. |
| `devices` | Paired browsers (one per extension install): name, SHA-256 of its key, last seen, extension version. The pre-devices shared token became the device "This computer" on upgrade. |
| `daily_snapshots` | Backlog and mastery per day for trend charts. |
| `app_meta` | Settings, the pending pairing code (hashed), revision counter, session aliases. |

- Foreign keys are enforced. Problems can't be deleted while referenced, and deleting a plan sets `assignments.plan_id` to null, so history survives.
- Multi-row operations run in transactions (nested ones use savepoints).
- WAL mode is on, so the CLI can read while the server runs.

## Dashboard

- Pages are server components that read SQLite directly through `@lcc/db`. They are always dynamic, never cached.
- Mutations are server actions (`apps/web/src/lib/actions.ts`); Next.js checks their origin.
- **Live updates:** a tiny client component polls `/api/revision`, a counter bumped by every write, every 3 seconds and calls `router.refresh()` when it changes. That's how extension captures appear without reloading. Client-side state such as half-typed notes survives the refresh.
- Autosave fields save after 800 ms idle, on blur and when the field leaves the page (in-app navigation). They show *Saving… / Saved / Not saved — retrying* and warn before unload while dirty.
  - The same text can be edited in another tab or in the extension's side panel. Each save sends the text the field last saw stored; if the stored text has changed since, nothing is written and the field shows the other version with **Keep mine** / **Use the other version**.
  - A field with no unsaved edits follows the stored text after a refresh.

## Server mode and the request boundary

See [SERVER_MODE.md](SERVER_MODE.md) for setup and the security model.
- **Config flow.**
  - `scripts/server-config.ts` reads `<data dir>/server.json`; the env vars `LCC_ALLOWED_HOSTS` and `LCC_LISTEN` override it. Parsing and validation live in `packages/shared/src/server-config.ts`.
  - `npm run up` resolves both before anything starts (an invalid config stops the start), hands the result to the server as those env vars, and binds to `0.0.0.0` only for `listen: "network"`.
  - The server itself reads only env: `apps/web/src/lib/server-mode.ts` (cached per process) and `next.config.ts` (`serverActions.allowedOrigins`).
  - `next start` evaluates `next.config.ts` at start, so a change needs a restart but no rebuild. The e2e boundary check confirms that an origin added only through env passes Next's server-action check.
- **Boundary.**
  - `apps/web/src/proxy.ts` is a thin wrapper around the pure `decideRequest` (`packages/shared/src/request-policy.ts`, unit-tested).
  - The Host must be loopback or a configured host, and a forwarded host must be one too.
  - Dashboard API origins must match the effective host, or be a configured host (for proxies that rewrite Host).
- **Devices** (`packages/db/src/devices.ts`): pairing codes, per-device keys, and the one-time conversion of the old shared token (`migrateLegacyPairing`, run in `openDb` after migrations).
- **Dev builds.** The e2e runner builds into its own `apps/web/.next-e2e` (`LCC_NEXT_DIST_DIR`) and empties it at the start of each run. A dev cache from older sources makes the first pages reload repeatedly while it catches up. On `dev:demo` that only costs a few seconds, but it can outlast the e2e flows' waits.

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
  - Cumulative events (activity, notes) are coalesced. A notes event carries only the fields edited in the panel since the last one was sent, plus a `base`: what the extension last knew the dashboard had for those fields. If the dashboard's text has changed since (typed there meanwhile), the server keeps it and adds the panel's text below the notes under a marker, so neither version is lost. The result reports the stored text, and the panel shows it with a "both versions kept" note.
  - The queue is capped at about 5 MB (storage holds 10 MB in all). Past that, activity snapshots go first, then the code of the oldest captured submissions (the submission and its verdict stay), and only then the new change. The panel says what was not kept until the queue has been sent.
  - A network or server error keeps the batch for retry: on every action, on `chrome.alarms` every 30 s (the alarm is checked for each time the service worker starts, so disabling and re-enabling the extension doesn't stop it), and on **Sync now**.
  - `rejected` results move to a failed list that is visible in the panel.
  - If the server keeps failing on a batch while it otherwise answers (its ping succeeds), events are retried one at a time, and one that still fails is set aside so the rest can sync. A set-aside event keeps its data and can be sent again with **Retry** in the panel. While the dashboard is offline, broken (every request fails) or not the program answering at that address, nothing is counted against any event.
- **Reconciliation:** every 30 s, local sessions with nothing waiting to be sent are checked against the server. A session finished or abandoned in the dashboard unbinds its tabs, and text typed in the dashboard replaces the panel's copy. A session the server no longer has is forgotten only after the dashboard's ping confirms it is the dashboard answering.
- **Session start paths**
  1. Dashboard **Start**: the server creates the session, then the tab opens with `#lcc-session=<id>` and the extension binds to it.
  2. A direct visit gets an offer (start, resume, history or ignore), shown in the page and in the panel.
  3. A second tab on the same problem auto-shares the open session.
  4. After a browser restart, the extension offers to resume.
  - A tab that navigates off leetcode.com is unbound (`tabs.onUpdated`; Chrome hides other sites' addresses, which is enough to tell). The session stays open, and returning to the problem offers to resume it. The tab's study-plan offer is dropped then too, and when the tab closes.

## Testing

| Layer | Where | How |
|---|---|---|
| Scheduler | `packages/scheduler/test` | Pure unit tests |
| Database / services | `packages/db/test` | In-memory SQLite with real migrations and made-up sample lists (`sampleLists()`); full simulated weeks |
| Extension logic | `apps/extension/test` | Controller with in-memory storage and a fake API; LeetCode-shaped fixtures |
| Dashboard E2E | `tests/e2e/ui-flow.ts` | Playwright against the running app |
| Extension E2E | `tests/e2e/extension-flow.ts` | Built extension in Chromium + real dashboard + stub LeetCode at real URLs, including study-plan pickup |
| Security boundary | `tests/e2e/boundary.ts` | Plain HTTP checks of Host (including server-mode and forwarded hosts), Origin, cross-site, key, pairing and header rules against the dashboard the E2E run starts (in server mode with one extra address) |
