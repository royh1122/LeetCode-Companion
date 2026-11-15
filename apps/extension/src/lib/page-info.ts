/**
 * The problem's number and title from the tab title, which looks like
 * "1768. Merge Strings Alternately - LeetCode" (or without the number).
 *
 * `staleTitle` is the tab title from before an in-app navigation to another problem. LeetCode
 * changes the address first and the title a moment later, so while the title is still that one
 * it belongs to the previous problem: report nothing rather than the wrong name and number.
 */
export function pageTitle(docTitle: string, staleTitle: string | null): { title: string | null; frontendId: string | null } {
  if (staleTitle !== null && docTitle === staleTitle) return { title: null, frontendId: null };
  const t = docTitle.replace(/\s*-\s*LeetCode\s*$/i, "").trim();
  const m = /^(\d+)\.\s+(.+)$/.exec(t);
  if (m) return { frontendId: m[1]!, title: m[2]! };
  return { frontendId: null, title: t && !/^leetcode/i.test(t) ? t : null };
}
