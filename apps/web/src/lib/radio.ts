import type * as React from "react";

/**
 * Arrow-key handling for a group of `role="radio"` buttons (WAI-ARIA radio group): Left/Up and
 * Right/Down move to the previous/next option, Home/End to the first/last, wrapping around, and
 * select it (by clicking it). Put it on the `role="radiogroup"` element, and give only the
 * checked option (or the first, if none is) `tabIndex={0}`: see `radioTabIndex`.
 */
export function onRadioGroupKeyDown(e: React.KeyboardEvent<HTMLElement>) {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (step === undefined && e.key !== "Home" && e.key !== "End") return;
  const radios = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not([disabled])')];
  if (!radios.length) return;
  const at = radios.indexOf(document.activeElement as HTMLElement);
  // With nothing focused yet, an arrow lands on the first option.
  const next = e.key === "Home" ? 0 : e.key === "End" ? radios.length - 1 : at < 0 ? 0 : (at + step! + radios.length) % radios.length;
  e.preventDefault();
  radios[next]!.focus();
  radios[next]!.click();
}

/** Roving tab stop: only one option of the group is reachable with Tab. */
export function radioTabIndex(index: number, checkedIndex: number): 0 | -1 {
  return index === Math.max(checkedIndex, 0) ? 0 : -1;
}
