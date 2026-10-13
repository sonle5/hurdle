import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export { formatDuration } from "./format-duration.mjs";

// Human-readable model label. Prefers the resolved version, falls back to the
// alias. Examples: claude-opus-4-7 → "Opus 4.7", claude-sonnet-4-6 → "Sonnet 4.6",
// gpt-5.5 → "GPT-5.5", opus → "Opus", "" → null.
export function formatModel(model?: string | null, resolved?: string | null): string | null {
  const raw = (resolved && resolved.trim()) || (model && model.trim()) || "";
  if (!raw) return null;
  if (/^gpt/i.test(raw)) return raw.toUpperCase();
  const s = raw.replace(/^claude-/, "");
  // Drop trailing date-stamp segments (e.g. claude-haiku-4-5-20251001 → Haiku 4.5).
  const [name, ...ver] = s.split("-").filter((p) => !/^\d{6,}$/.test(p));
  const titled = name.charAt(0).toUpperCase() + name.slice(1);
  return ver.length ? `${titled} ${ver.join(".")}` : titled;
}
