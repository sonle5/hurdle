import { ThemeToggle } from "./ThemeToggle";
import { TogetherCredit } from "./TogetherCredit";

export function SidebarFooter() {
  return (
    <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-rule px-3 py-3">
      <TogetherCredit />
      <ThemeToggle />
    </footer>
  );
}
