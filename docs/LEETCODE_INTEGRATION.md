# LeetCode integration: research, approach, limitations

## Research summary (November 2026)

| Topic | Finding | Confidence |
|---|---|---|
| Official API | None. LeetCode exposes an internal GraphQL endpoint (`/graphql/`) and internal REST endpoints used by its own web app. Neither is documented or stable. | High |
| Study lists | No LeetCode list data ships with the app, and the app never fetches one. When you click into a study plan inside LeetCode, the page requests its list with a GraphQL call (`operationName: studyPlanDetail`, response `data.studyPlanV2Detail`: slug, name, groups of questions). On a full page load it requests nothing and embeds the same data in `<script id="__NEXT_DATA__">` at `props.pageProps.dehydratedState.queries[].state.data.studyPlanV2Detail`. The extension reads either one; the side panel offers to import the plan only on that plan's `/studyplan/<slug>/` page, and nothing is sent to the dashboard until you click Import (`POST /api/ext/lists`, token-protected). | Both observed on leetcode.com (DevTools, Nov 2026); fixtures in `apps/extension/test/fixtures.ts`. |
| Submit | The page sends `POST /problems/{slug}/submit/` with JSON body `{lang, question_id, typed_code, …}` and gets back `{submission_id}` (an integer). | Observed on a logged-in account |
| Run | `POST /problems/{slug}/interpret_solution/` with a body that adds `data_input`, returning `{interpret_id, test_case}`. Interpret ids are strings like `runcode_<ts>_<rand>`. | From LeetHub-3.0 and leetcode-cli source; not yet observed on a logged-in account |
| Result | The page polls `GET /submissions/detail/{id}/v2/check/` (the older `/check/` path is also matched) until `state == "SUCCESS"`. Relevant fields: `status_msg`, `status_code` (10 AC, 11 WA, 12 MLE, 13 OLE, 14 TLE, 15 RE, 20 CE), `status_runtime`, `status_memory`, `total_correct`, `total_testcases`, `lang`, `question_id`, `last_testcase`, `expected_output`, `code_output`, `full_compile_error`, `full_runtime_error`, `task_finish_time`. `status_runtime` and `status_memory` are `"N/A"` on non-Accepted results and stored as empty. | Observed on a logged-in account (Wrong Answer, Accepted) |
| Editor | Monaco. The extension does **not** read the editor; code comes only from the submit/run request body. | n/a |
| Page type | A single-page app: switching problems usually doesn't reload the page. | High |
| CSP | Scripts declared with `"world": "MAIN"` in the manifest are injected by Chrome and bypass page CSP. LeetHub-3.0 uses the same approach. | High |
| Bot protection | leetcode.com sits behind Cloudflare. Headless automation receives a challenge page. | Verified |
| Terms of Service | An automated summary of https://leetcode.com/terms/ (Nov 2026; not a verbatim read) reports bans on crawling, scraping and spidering the service and on processes that run while you are not logged in, and says LeetCode's content is its property. It found no clause about browser extensions. This extension does none of those: it runs only in your logged-in tab and reads what the page already loaded. Read the terms yourself; you are responsible for your use. | Summary only |

## Approach chosen

The extension **observes your normal browser activity; it never makes requests to LeetCode.**

1. A MAIN-world content script wraps `window.fetch` and `XMLHttpRequest`.
   - It passes every request through unchanged.
   - It inspects only submit, run and check requests, plus GraphQL requests whose body asks for `studyPlanV2Detail`, reading the request body and a *clone* of the response.
   - All other traffic, including every other GraphQL call, is ignored. Errors inside the hook are swallowed so the page can't break.
2. Captured data is posted to the isolated content script with `window.postMessage`. The message is checked for the same window, the same origin and its shape, then forwarded to the service worker.
3. The service worker attributes it to the session bound to that tab (same problem only), queues sync events, and sends them to the local dashboard. A submit or run is only accepted for the problem open in that tab, and a verdict only for a submit or run it saw.
4. Problem detection uses only the URL (`/problems/{slug}/…`), polled every second for SPA navigation, plus `document.title` for the number and title. On `/studyplan/<slug>/` pages only, the isolated script also reads the plan data LeetCode embeds in `<script id="__NEXT_DATA__">`, and uses it only if it describes the plan in the address bar.

### Why this is low-risk

- There is no polling of private endpoints, no extra requests, no rate-limit exposure, and nothing bypassing auth or bot protection.
- It reads only the user's own traffic in the user's own browser.
- It needs minimal permissions: `storage`, `sidePanel` and `alarms`. Host access is limited to `leetcode.com`, `127.0.0.1` and `localhost`. It doesn't need `tabs`, `scripting`, `webRequest` or `cookies`.
- Your LeetCode credentials are never touched. Data goes only to the local dashboard.

### Risks and fragility (be aware)

- These are **internal endpoints and may change without notice.** If LeetCode moves Submit to GraphQL or renames a path, capture stops silently on their side. In that case the side panel shows **"Capture unavailable on this page"** only if the hook itself fails to load. If the hook loads but the endpoints changed, you will simply see no submissions appear. Use **Log a submission manually** in that case.
- The unit tests use fixtures based on real responses (ids and marketing text replaced) and published shapes (`apps/extension/test/fixtures.ts`). Re-check them against DevTools → Network if capture breaks.
- Another script running on leetcode.com (an XSS there, or another extension) could forge `postMessage` events or plant fake page data. The extension limits what that can do: a submission is accepted only for the problem open in that tab, a verdict only for a submission it saw, message sizes are capped, a study-plan offer still needs your click to import, and an imported list only fills in missing problem details. The worst case is fake submissions for the problem you have open, in *your* local history. Such a script can't read your data, get the pairing token or change the dashboard address: the service worker only answers those requests from the extension's own pages.
- The Terms may discourage automated access. This extension performs none, but you are responsible for how you use it.

## Reliable vs. best-effort

| Feature | Reliability |
|---|---|
| Problem detection from the URL, including SPA navigation | Reliable |
| Tab ↔ session binding, refresh, multiple tabs, browser restart | Reliable (tested) |
| Active-time estimate | **Estimate.** Counts 15-second heartbeat intervals that began with the tab visible and focused and with input within the idle threshold (default 5 min, configurable). Long gaps (sleep, browser closed) are never counted. Reading without touching mouse or keyboard for longer than the threshold is *not* counted. Shown with "≈". |
| Submit capture (code, language, verdict, runtime, memory, test counts) | **Best-effort.** Depends on LeetCode's internal endpoints. |
| Run capture | Best-effort. Stored with `kind = run` and never counted as a submission. |
| Time to first Accepted | Only when an Accepted submit was captured or logged |
| Manual fallback (timer, notes, outcome, manual submission) | Reliable; needs no extension |

## Identity and deduplication

- **Problems:** `(platform, slug)` is unique. LeetCode's internal `questionId` is stored and also unique when known. There is one row per problem regardless of list membership.
- **Submissions:**
  - LeetCode's `submission_id` (or interpret id) is unique when present.
  - **Fallback identity** when there is no platform id (manual entries, or a changed response shape): `sha256(problemId | kind | minute(submittedAt) | lang | code)`. Logging the identical code twice in the same minute counts as one.
  - Code is never overwritten. A result that arrives before its code creates a row whose `code` is `null`, and that is marked "No code captured" in the UI.
- **Sync events:**
  - Every event has a client-generated UUID and is processed at most once (the `sync_events` table).
  - Retries return `duplicate`. Permanent failures return `rejected`, are stored with the error, and appear in the panel and in Settings → Sync log.
- **Sessions:** at most one *open* session per problem (partial unique index).
  - Starting again, a refresh, or a second tab resumes the open session instead of creating a new one.
  - If the extension created a session offline while another was opened on the dashboard, the server keeps the existing one and aliases the extension's id to it.

## Submission attribution

- **bound:** the tab was bound to that session and the problem matches.
- **inferred:** no binding, but exactly one session for that problem was open at submission time (labeled "Auto-linked").
- **none:** anything ambiguous. These show up as *Unlinked submissions* on the question page and in Settings, where you can link them manually. Nothing is guessed silently.

## Extension ↔ dashboard security

- The dashboard binds to `127.0.0.1` only. `proxy.ts` rejects any request whose `Host` isn't loopback, which blocks DNS rebinding.
- `/api/ext/*` requires `Authorization: Bearer <pairing token>`. The token is random (192-bit), compared in constant time, and rotatable.
  - Requests with a web `Origin` are refused.
  - No CORS headers are ever sent, so web pages can neither read responses nor pass the preflight that the `Authorization` header would trigger.
- Dashboard APIs (`/api/export`, `/api/revision`) accept same-origin requests only. Next.js server actions check `Origin` against `Host`. Pages send `X-Frame-Options: DENY`.
- Captured code is rendered through highlight.js, which escapes HTML. It is never executed.
