"use client";

import { useCallback, useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { readStoredPreference } from "@/lib/browser-preference-storage.mjs";
import { cn } from "@/lib/utils";

export type ThemeChoice = "light" | "system" | "dark";

const STORAGE_KEY = "hurdle-theme";
const TRANSITION_CLASS = "theme-changing";
let transitionFrame: number | null = null;
let cleanupFrame: number | null = null;

function readChoice(): ThemeChoice {
  if (typeof window === "undefined") return "system";
  try {
    const stored = readStoredPreference(localStorage, STORAGE_KEY);
    if (stored === "light" || stored === "system" || stored === "dark") {
      return stored;
    }
  } catch {}
  return "system";
}

function applyChoice(choice: ThemeChoice) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (transitionFrame !== null) window.cancelAnimationFrame(transitionFrame);
  if (cleanupFrame !== null) window.cancelAnimationFrame(cleanupFrame);
  root.classList.add(TRANSITION_CLASS);
  void root.offsetHeight;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = choice === "dark" || (choice === "system" && prefersDark);
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  transitionFrame = window.requestAnimationFrame(() => {
    cleanupFrame = window.requestAnimationFrame(() => {
      root.classList.remove(TRANSITION_CLASS);
      transitionFrame = null;
      cleanupFrame = null;
    });
  });
}

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>("system");

  useEffect(() => {
    const stored = readChoice();
    setChoice(stored);
    applyChoice(stored);
  }, []);

  const select = useCallback((next: ThemeChoice) => {
    setChoice(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
    applyChoice(next);
  }, []);

  const choices: { value: ThemeChoice; Icon: typeof Sun; label: string }[] = [
    { value: "light", Icon: Sun, label: "Light" },
    { value: "system", Icon: Monitor, label: "System" },
    { value: "dark", Icon: Moon, label: "Dark" },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex shrink-0 items-center gap-px rounded-md border border-rule bg-background p-0.5"
    >
      {choices.map(({ value, Icon, label }) => {
        const active = choice === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            onClick={() => select(value)}
            className={cn(
              "inline-flex h-6 w-6 items-center justify-center rounded-sm transition-colors",
              active
                ? "bg-surface text-foreground"
                : "text-fg-faint hover:text-foreground",
            )}
          >
            <Icon className="h-3 w-3" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
