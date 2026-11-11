/**
 * LeetCode-specific parsing shared by the extension (capture) and the server
 * (validation). Everything here is defensive: LeetCode has no stable public
 * API, so unknown shapes degrade to "Unknown" instead of throwing.
 * See docs/LEETCODE_INTEGRATION.md.
 */
import type { Difficulty, Verdict } from "./enums";

const PROBLEM_PATH_RE = /^\/problems\/([a-z0-9-]+)(?:\/|$)/i;

/** Extract the problem slug from a leetcode.com URL or pathname. */
export function parseProblemSlug(urlOrPath: string): string | null {
  let pathname = urlOrPath;
  try {
    const u = new URL(urlOrPath, "https://leetcode.com");
    if (!/(^|\.)leetcode\.com$/i.test(u.hostname)) return null;
    pathname = u.pathname;
  } catch {
    return null;
  }
  const m = PROBLEM_PATH_RE.exec(pathname);
  return m?.[1] ? m[1].toLowerCase() : null;
}

export function problemUrl(slug: string): string {
  return `https://leetcode.com/problems/${slug}/`;
}

export type LeetCodeRequestKind =
  | { kind: "submit"; slug: string }
  | { kind: "run"; slug: string }
  | { kind: "check"; id: string }
  /** The page's own GraphQL calls; only read on study-plan pages, for the plan's question list. */
  | { kind: "graphql" }
  | null;

/** Classify a request the LeetCode page made. Run and Submit are distinct endpoints. */
export function classifyLeetCodeRequest(method: string, url: string): LeetCodeRequestKind {
  let u: URL;
  try {
    u = new URL(url, "https://leetcode.com");
  } catch {
    return null;
  }
  if (!/(^|\.)leetcode\.com$/i.test(u.hostname)) return null;
  const m = method.toUpperCase();
  let r: RegExpExecArray | null;
  if (m === "POST" && (r = /^\/problems\/([a-z0-9-]+)\/submit\/?$/i.exec(u.pathname))) {
    return { kind: "submit", slug: r[1]!.toLowerCase() };
  }
  if (m === "POST" && (r = /^\/problems\/([a-z0-9-]+)\/interpret_solution\/?$/i.exec(u.pathname))) {
    return { kind: "run", slug: r[1]!.toLowerCase() };
  }
  if (m === "GET" && (r = /^\/submissions\/detail\/([A-Za-z0-9_.-]+)\/(?:v\d+\/)?check\/?$/.exec(u.pathname))) {
    return { kind: "check", id: r[1]! };
  }
  if (m === "POST" && /^\/graphql\/?$/.test(u.pathname)) return { kind: "graphql" };
  return null;
}

/** Run ("interpret") ids are strings like runcode_1700000000.12_abc; submit ids are integers. */
export function isRunId(id: string): boolean {
  return !/^\d+$/.test(id);
}

const STATUS_CODE_VERDICTS: Record<number, Verdict> = {
  10: "Accepted",
  11: "Wrong Answer",
  12: "Memory Limit Exceeded",
  13: "Output Limit Exceeded",
  14: "Time Limit Exceeded",
  15: "Runtime Error",
  20: "Compile Error",
};

/** Normalize a judge result. status_msg wins; status_code is a fallback. */
export function normalizeVerdict(statusMsg: unknown, statusCode?: unknown): Verdict {
  if (typeof statusMsg === "string") {
    const s = statusMsg.trim().toLowerCase();
    if (s === "accepted") return "Accepted";
    if (s.startsWith("wrong answer")) return "Wrong Answer";
    if (s.startsWith("time limit")) return "Time Limit Exceeded";
    if (s.startsWith("memory limit")) return "Memory Limit Exceeded";
    if (s.startsWith("output limit")) return "Output Limit Exceeded";
    if (s.startsWith("runtime error")) return "Runtime Error";
    if (s.startsWith("compile error") || s.startsWith("compilation error")) return "Compile Error";
  }
  if (typeof statusCode === "number" && STATUS_CODE_VERDICTS[statusCode]) return STATUS_CODE_VERDICTS[statusCode]!;
  return "Unknown";
}

export function normalizeDifficulty(d: unknown): Difficulty {
  if (typeof d !== "string") return "Unknown";
  const s = d.toLowerCase();
  if (s === "easy") return "Easy";
  if (s === "medium") return "Medium";
  if (s === "hard") return "Hard";
  return "Unknown";
}

/** Parse "3 ms" → 3, "17.2 MB" → 17.2. */
export function parseLeadingNumber(s: unknown): number | null {
  if (typeof s === "number" && Number.isFinite(s)) return s;
  if (typeof s !== "string") return null;
  const m = /-?\d+(\.\d+)?/.exec(s);
  return m ? Number(m[0]) : null;
}

const MAX_DETAIL = 2000;
function clip(v: unknown): string | null {
  if (v == null) return null;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (!s) return null;
  return s.length > MAX_DETAIL ? `${s.slice(0, MAX_DETAIL)}…` : s;
}

export interface JudgeResult {
  verdict: Verdict;
  statusCode: number | null;
  runtime: string | null;
  memory: string | null;
  totalCorrect: number | null;
  totalTestcases: number | null;
  runtimePercentile: number | null;
  memoryPercentile: number | null;
  lang: string | null;
  questionId: string | null;
  finishedAt: number | null;
  details: Record<string, string | null>;
}

/**
 * Parse a final /submissions/detail/{id}/check/ response.
 * Returns null if the judge has not finished (state !== SUCCESS).
 */
export function parseCheckResponse(body: unknown): JudgeResult | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.state !== "SUCCESS") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const finish = num(b.task_finish_time);
  // LeetCode reports "N/A" for runtime/memory on non-accepted results.
  const display = (v: unknown) => (typeof v === "string" && v.trim() && v.trim().toUpperCase() !== "N/A" ? v : null);
  return {
    verdict: normalizeVerdict(b.status_msg, b.status_code),
    statusCode: num(b.status_code),
    runtime: display(b.status_runtime),
    memory: display(b.status_memory),
    totalCorrect: num(b.total_correct),
    totalTestcases: num(b.total_testcases),
    runtimePercentile: num(b.runtime_percentile),
    memoryPercentile: num(b.memory_percentile),
    lang: typeof b.lang === "string" ? b.lang : null,
    questionId: b.question_id != null ? String(b.question_id) : null,
    // task_finish_time is epoch ms on current LeetCode; tolerate seconds.
    finishedAt: finish == null ? null : finish < 1e12 ? finish * 1000 : finish,
    details: {
      lastTestcase: clip(b.last_testcase),
      expectedOutput: clip(b.expected_output),
      codeOutput: clip(b.code_output),
      compileError: clip(b.full_compile_error ?? b.compile_error),
      runtimeError: clip(b.full_runtime_error ?? b.runtime_error),
    },
  };
}

/** Language slug → highlight.js language name. */
export function highlightLanguage(lang: string | null | undefined): string {
  const l = (lang ?? "").toLowerCase();
  if (l.startsWith("python")) return "python";
  if (l === "cpp" || l === "c++") return "cpp";
  if (l === "c") return "c";
  if (l === "java") return "java";
  if (l === "javascript") return "javascript";
  if (l === "typescript") return "typescript";
  if (l === "golang" || l === "go") return "go";
  if (l === "rust") return "rust";
  if (l === "kotlin") return "kotlin";
  if (l === "swift") return "swift";
  if (l === "csharp" || l === "c#") return "csharp";
  if (l === "ruby") return "ruby";
  if (l === "scala") return "scala";
  if (l === "php") return "php";
  return "plaintext";
}
