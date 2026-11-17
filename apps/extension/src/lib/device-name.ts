/**
 * A default name for this browser in the dashboard's Devices list ("Edge on Windows"), editable there.
 * Best effort from the user agent; iPadOS in desktop mode reports a Mac, so touch support tells them apart.
 */
export function deviceNameFromUserAgent(ua: string, hints: { maxTouchPoints?: number; brave?: boolean } = {}): string {
  const has = (s: string) => ua.includes(s);
  const browser = has("Edg/") || has("EdgA/") || has("EdgiOS/")
    ? "Edge"
    : has("OPR/")
      ? "Opera"
      : has("Vivaldi/")
        ? "Vivaldi"
        : hints.brave
          ? "Brave"
          : has("Firefox/") || has("FxiOS/")
            ? "Firefox"
            : has("Chrome/") || has("CriOS/")
              ? "Chrome"
              : has("Safari/")
                ? "Safari"
                : "Browser";
  const touch = (hints.maxTouchPoints ?? 0) > 1;
  const os = has("iPad") || (has("Macintosh") && touch)
    ? "iPadOS"
    : has("iPhone")
      ? "iOS"
      : has("Android")
        ? "Android"
        : has("CrOS")
          ? "ChromeOS"
          : has("Windows")
            ? "Windows"
            : has("Macintosh")
              ? "macOS"
              : has("Linux")
                ? "Linux"
                : "";
  return os ? `${browser} on ${os}` : browser;
}
