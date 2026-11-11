import { classifyLeetCodeRequest, isRunId, parseCheckResponse, type JudgeResult } from "@lcc/shared/leetcode";

/**
 * Pure interpretation of a request/response pair the LeetCode page made.
 * Used by the MAIN-world hook; kept free of DOM/chrome APIs so it can be tested
 * against fixtures. Returns null for anything we don't understand.
 */
export type Intercepted =
  | { type: "submit"; slug: string; submissionId: string | null; lang: string | null; questionId: string | null; code: string | null }
  | { type: "run"; slug: string; interpretId: string | null; lang: string | null; questionId: string | null; code: string | null }
  | { type: "check"; id: string; kind: "submit" | "run"; result: JudgeResult }
  | { type: "studyplan"; list: CapturedList };

/** A study plan as the page's own studyPlanV2Detail response describes it, trimmed to what the dashboard uses. */
export interface CapturedList {
  slug: string;
  name: string;
  description: string | null;
  planSubGroups: { name: string | null; questions: { titleSlug: string; title: string | null; questionFrontendId: string | null; difficulty: string | null; paidOnly: boolean; topicTags: { name: string; slug: string }[] }[] }[];
}

const MAX_LIST = 3000;

/** The only GraphQL request we read: the page asking for a study plan (operation studyPlanDetail → studyPlanV2Detail). */
export function asksForStudyPlan(requestBody: string | null | undefined): boolean {
  return !!requestBody && requestBody.includes("studyPlanV2Detail");
}
const str = (v: unknown) => (typeof v === "string" ? v : null);

function studyPlanFrom(res: Record<string, unknown> | null): CapturedList | null {
  const p = (res?.data as { studyPlanV2Detail?: Record<string, unknown> } | undefined)?.studyPlanV2Detail;
  if (!p || typeof p.slug !== "string" || typeof p.name !== "string" || !Array.isArray(p.planSubGroups)) return null;
  const planSubGroups = (p.planSubGroups as Record<string, unknown>[]).map((g) => ({
    name: str(g?.name),
    questions: (Array.isArray(g?.questions) ? (g.questions as Record<string, unknown>[]) : [])
      .filter((q) => typeof q?.titleSlug === "string")
      .map((q) => ({
        titleSlug: q.titleSlug as string,
        title: str(q.title),
        questionFrontendId: str(q.questionFrontendId),
        difficulty: str(q.difficulty),
        paidOnly: q.paidOnly === true,
        topicTags: Array.isArray(q.topicTags)
          ? (q.topicTags as { name?: unknown; slug?: unknown }[]).filter((t) => typeof t?.name === "string" && typeof t?.slug === "string").map((t) => ({ name: t.name as string, slug: t.slug as string }))
          : [],
      })),
  }));
  const n = planSubGroups.reduce((a, g) => a + g.questions.length, 0);
  if (!n || n > MAX_LIST) return null;
  return { slug: p.slug, name: p.name, description: str(p.description), planSubGroups };
}

const MAX_CODE = 200_000;

function parseJson(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The study-plan slug in a leetcode.com/studyplan/<slug>/ path, if any. */
export function studyPlanSlug(pathname: string): string | null {
  const m = /^\/studyplan\/([a-z0-9-]+)\/?$/i.exec(pathname);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * On a full page load LeetCode doesn't request the list; it embeds it in the page
 * (<script id="__NEXT_DATA__">, props.pageProps.dehydratedState.queries[].state.data).
 * Returns the plan only if it is the one in the address bar: after in-app navigation
 * the embedded data still describes the first page loaded.
 */
export function studyPlanFromNextData(text: string | null | undefined, pathname: string): CapturedList | null {
  const slug = studyPlanSlug(pathname);
  if (!slug || !text || text.length > 5_000_000) return null;
  let d: { props?: { pageProps?: { dehydratedState?: { queries?: { state?: { data?: { studyPlanV2Detail?: unknown } } }[] } } } };
  try {
    d = JSON.parse(text);
  } catch {
    return null;
  }
  const queries = d?.props?.pageProps?.dehydratedState?.queries;
  if (!Array.isArray(queries)) return null;
  for (const q of queries) {
    const p = q?.state?.data?.studyPlanV2Detail;
    if (!p) continue;
    const list = studyPlanFrom({ data: { studyPlanV2Detail: p } });
    if (list && list.slug.toLowerCase() === slug) return list;
  }
  return null;
}

export function interpret(method: string, url: string, requestBody: string | null, responseBody: unknown): Intercepted | null {
  const k = classifyLeetCodeRequest(method, url);
  if (!k) return null;
  const res = typeof responseBody === "string" ? parseJson(responseBody) : (responseBody as Record<string, unknown> | null);
  if (k.kind === "graphql") {
    if (!asksForStudyPlan(requestBody)) return null;
    const list = studyPlanFrom(res);
    return list ? { type: "studyplan", list } : null;
  }
  if (k.kind === "check") {
    const result = parseCheckResponse(res);
    if (!result) return null; // still PENDING/STARTED
    return { type: "check", id: k.id, kind: isRunId(k.id) ? "run" : "submit", result };
  }
  const req = parseJson(requestBody);
  const code = typeof req?.typed_code === "string" ? req.typed_code.slice(0, MAX_CODE) : null;
  const lang = typeof req?.lang === "string" ? req.lang : null;
  const questionId = req?.question_id != null ? String(req.question_id) : null;
  if (k.kind === "submit") {
    const sid = res?.submission_id;
    return { type: "submit", slug: k.slug, submissionId: sid != null && sid !== "" ? String(sid) : null, lang, questionId, code };
  }
  const iid = res?.interpret_id;
  return { type: "run", slug: k.slug, interpretId: typeof iid === "string" || typeof iid === "number" ? String(iid) : null, lang, questionId, code };
}

/** Shape check for messages relayed from the page (MAIN world) to the isolated content script. */
export function isInterceptedMessage(d: unknown): d is { __lcc: true; payload: Intercepted } | { __lcc: true; ready: true } {
  if (!d || typeof d !== "object") return false;
  const m = d as Record<string, unknown>;
  if (m.__lcc !== true) return false;
  if (m.ready === true) return true;
  // Any script on the page can post these, so check the full shape and cap the size.
  const p = m.payload as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return false;
  try {
    if (JSON.stringify(p).length > (p.type === "studyplan" ? 2_000_000 : MAX_CODE + 50_000)) return false;
  } catch {
    return false;
  }
  if (p.type === "check") return typeof p.id === "string" && !!p.result && typeof p.result === "object" && typeof (p.result as { verdict?: unknown }).verdict === "string";
  if (p.type === "studyplan") {
    const l = p.list as Partial<CapturedList> | undefined;
    if (!l || typeof l.slug !== "string" || typeof l.name !== "string" || !Array.isArray(l.planSubGroups)) return false;
    let n = 0;
    for (const g of l.planSubGroups) {
      if (!g || !Array.isArray(g.questions)) return false;
      for (const q of g.questions) if (typeof q?.titleSlug !== "string") return false;
      n += g.questions.length;
    }
    return n > 0 && n <= MAX_LIST;
  }
  if (p.type !== "submit" && p.type !== "run") return false;
  return typeof p.slug === "string" && (p.code == null || (typeof p.code === "string" && p.code.length <= MAX_CODE));
}
