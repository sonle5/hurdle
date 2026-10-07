import { readStoredPreference } from "./browser-preference-storage.mjs";

export const DEFAULT_TRANSCRIPT_RAIL_WIDTH = 320;
export const MIN_TRANSCRIPT_RAIL_WIDTH = 288;
export const MAX_TRANSCRIPT_RAIL_WIDTH = 480;
export const TRANSCRIPT_RAIL_WIDTH_STORAGE_KEY = "hurdle-transcript-rail-width";

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
  } catch {
    // Layout persistence is an enhancement; collapsing still works without it.
  }
}
