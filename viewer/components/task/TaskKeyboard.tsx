"use client";

import { useRouter } from "next/navigation";
import { useHotkeys, moveRowFocus } from "@/lib/hotkeys";

// Tiny invisible client component that wires keyboard nav for the Task page.
// The Task page itself is a server component; this lets us register hotkeys
// without making the whole page client.
export function TaskKeyboard() {
  const router = useRouter();
  useHotkeys({
    "j": (e) => { e.preventDefault(); moveRowFocus("[data-row-focus]", +1); },
    "k": (e) => { e.preventDefault(); moveRowFocus("[data-row-focus]", -1); },
    "g l": () => router.push("/"),
  });
  return null;
}
