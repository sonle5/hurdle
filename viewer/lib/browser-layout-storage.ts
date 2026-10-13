import { readStoredPreference } from "./browser-preference-storage.mjs";

export const DEFAULT_SIDEBAR_WIDTH = 256;
export const MIN_SIDEBAR_WIDTH = 224;
export const MAX_SIDEBAR_WIDTH = 480;
// Wide enough that the brand tile sits 20px from the edge, exactly where it
// sits in the expanded rail.
export const COLLAPSED_SIDEBAR_WIDTH = 60;
export const SIDEBAR_WIDTH_STORAGE_KEY = "hurdle-sidebar-width";
export const SIDEBAR_COLLAPSED_STORAGE_KEY = "hurdle-sidebar-collapsed";

export function readSidebarLayout(storage: Pick<Storage, "getItem">, defaultCollapsed = false) {
  const collapsed = readStoredPreference(storage, SIDEBAR_COLLAPSED_STORAGE_KEY);
  return {
    width: parseStoredWidth(readStoredPreference(storage, SIDEBAR_WIDTH_STORAGE_KEY), DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH),
    collapsed: collapsed === "true" ? true : collapsed === "false" ? false : defaultCollapsed,
  };
}

export function parseStoredWidth(value: string | null | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function readStoredWidth(key: string, fallback: number, minimum: number, maximum: number) {
  if (typeof window === "undefined") return fallback;
  try {
    return parseStoredWidth(readStoredPreference(window.localStorage, key), fallback, minimum, maximum);
  } catch {
    return fallback;
  }
}

export function writeStoredWidth(key: string, width: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(width));
    document.cookie = `${encodeURIComponent(key)}=${encodeURIComponent(String(width))}; Path=/; Max-Age=31536000; SameSite=Lax`;
  } catch {
    // Layout persistence is an enhancement; resizing still works without it.
  }
}

export function readStoredBoolean(key: string): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const value = readStoredPreference(window.localStorage, key);
    return value === "true" ? true : value === "false" ? false : null;
  } catch {
    return null;
  }
}

export function writeStoredBoolean(key: string, value: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(value));
    document.cookie = `${encodeURIComponent(key)}=${String(value)}; Path=/; Max-Age=31536000; SameSite=Lax`;
  } catch {
    // Layout persistence is an enhancement; collapsing still works without it.
  }
}
