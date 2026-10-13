import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("run review has no separate Run details page or navigation", () => {
  for (const path of [
    "../app/runs/[id]/page.tsx",
    "../components/canonical/CanonicalRunDetail.tsx",
    "../components/canonical/CanonicalRunList.tsx",
    "../components/canonical/RunTruthFields.mjs",
    "../lib/canonical-format.mjs",
    "../lib/canonical-format.d.mts",
  ]) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false, `${path} should be removed`);
  }
  const review = source("../components/CanonicalSessionReview.tsx");
  assert.doesNotMatch(review, /Run details|href=\{`\/runs\//);
  assert.match(review, /Evaluation checks/);
  assert.match(review, /Judge review/);
  assert.match(review, /sources=\{evaluatorSources\}/);
  const session = source("../app/s/[id]/page.tsx");
  assert.match(session, /<CanonicalSessionReview/);
  assert.match(session, /<SessionDetailTabs/);
  assert.match(session, /id="evidence"/);
  assert.match(session, /<ConversationView/);
});

test("the mature dashboard reads canonical records without copying or rescoring them", () => {
  const home = source("../app/page.tsx");
  const session = source("../app/s/[id]/page.tsx");
  const projection = source("../lib/canonical-dashboard-projection.mjs");
  const queries = source("../lib/queries.ts");
  const storeSource = source("../lib/canonical-store.server.ts");

  assert.match(home, /<Leaderboard/);
  assert.match(home, /getAllSessions/);
  assert.doesNotMatch(queries, /shouldUseLocal|getDb|drizzle/);
  assert.match(queries, /getCanonicalDashboardSource/);
  assert.match(projection, /headline\?\.verdict \?\? record\.verdict/);
  assert.match(projection, /reader\.readEvidence/);
  assert.match(projection, /MAX_CANONICAL_DASHBOARD_TRANSCRIPT_BYTES/);
  for (const forbidden of [
    "evaluateAuthority",
    "deriveRunOutcome",
    "deterministicRunVerdict",
    "verifyTaskDeterministicChecks",
    "openLocalResultStore(",
    "openPostgresResultStore(",
    "INSERT INTO",
    "sessions table",
  ]) {
    assert.doesNotMatch(projection, new RegExp(forbidden.replace("(", "\\(")));
  }
  assert.doesNotMatch(session, /verifyTaskDeterministicChecks/);
  assert.doesNotMatch(session, /canonicalDetailHref|canonical truth|Canonical Run Record/i);
  assert.doesNotMatch(session, /FailureReviewCard|manualOverride/);
  assert.match(session, /<CanonicalSessionReview/);
  assert.match(session, /taskPrompt:\s*dbSession\.prompt/);
  assert.match(session, /<details open className="group">/);

  assert.match(source("../lib/canonical-results.server.ts"), /import "server-only"/);
  assert.match(storeSource, /HURDLE_RESULT_STORE_ROOT/);
  assert.match(storeSource, /HURDLE_RESULT_STORE_MODE/);
  assert.match(storeSource, /HURDLE_RESULT_STORE_DATABASE_URL/);
  assert.match(storeSource, /openPostgresResultStoreReader/);
  assert.doesNotMatch(storeSource, /process\.env\.DATABASE_URL/);

  const layout = source("../app/layout.tsx");
  assert.doesNotMatch(layout, /ClerkProvider|MCP and Skills/);
  assert.match(layout, /canonical Run Records/);

  const proxy = source("../proxy.ts");
  assert.match(proxy, /local-only/);
  assert.match(proxy, /read-only/);
  assert.doesNotMatch(proxy, /HURDLE_VIEWER_READ_ONLY|clerk/i);

  const packageJson = JSON.parse(source("../package.json"));
  assert.equal(packageJson.scripts.predev, undefined);
  assert.equal(packageJson.scripts.prebuild, undefined);
  assert.equal(packageJson.scripts["sync-data"], undefined);
  assert.equal(existsSync(new URL("../scripts/sync-data.mjs", import.meta.url)), false);
  assert.equal(existsSync(new URL("../scripts/seed-db.mjs", import.meta.url)), false);
  assert.equal(existsSync(new URL("../data/.gitkeep", import.meta.url)), false);

  assert.equal(existsSync(new URL("../../vercel.json", import.meta.url)), false);
});

test("the local Viewer serves its agent and brand assets", () => {
  for (const name of ["claude-logo.svg", "codex-logo.svg", "together-logo-light.png", "together-logo.png"]) {
    assert.equal(existsSync(new URL("../public/" + name, import.meta.url)), true);
  }
});

test("agent logos use dark-surface-safe variants consistently", () => {
  const logo = source("../components/AgentLogo.tsx");
  const runRow = source("../components/leaderboard/RunRow.tsx");
  const taskTable = source("../components/TaskTable.tsx");

  assert.match(logo, /MONOCHROME_AGENTS = new Set.*"CDX".*"Pi"/s);
  assert.match(logo, /dark:brightness-0 dark:invert/);
  assert.match(logo, /agent === "CC".*"\/claude-logo\.svg"/s);
  assert.match(runRow, /<AgentLogo agent=\{s\.agent\}/);
  assert.match(taskTable, /<AgentLogo agent=\{s\.agent\}/);
});

test("the Viewer follows the system theme by default and exposes a three-state chooser", () => {
  const layout = source("../app/layout.tsx");
  const sessionSidebar = source("../components/SessionSidebar.tsx");
  const leftRail = source("../components/shell/LeftRail.tsx");
  const sidebarFooter = source("../components/shell/SidebarFooter.tsx");
  const themeToggle = source("../components/shell/ThemeToggle.tsx");

  assert.doesNotMatch(layout, /dark h-full antialiased/);
  assert.match(layout, /THEME_SCRIPT/);
  assert.match(layout, /localStorage\.getItem\('hurdle-theme'\)/);
  assert.match(layout, /: 'system'/);
  assert.match(layout, /prefers-color-scheme: dark/);
  assert.match(layout, /preference\.addEventListener\('change', apply\)/);
  assert.match(sessionSidebar, /<SidebarFooter \/>/);
  assert.match(leftRail, /<SidebarFooter \/>/);
  assert.match(sidebarFooter, /<ThemeToggle \/>/);
  assert.match(themeToggle, /useState<ThemeChoice>\("system"\)/);
  assert.match(themeToggle, /value: "light"/);
  assert.match(themeToggle, /value: "system"/);
  assert.match(themeToggle, /value: "dark"/);
  assert.match(themeToggle, /localStorage\.setItem\(STORAGE_KEY, next\)/);
  assert.doesNotMatch(themeToggle, /title=\{label\}/);
  assert.match(themeToggle, /classList\.add\(TRANSITION_CLASS\)/);
  assert.match(themeToggle, /requestAnimationFrame/);
  assert.match(layout, /classList\.add\('theme-changing'\)/);
  assert.match(layout, /classList\.remove\('theme-changing'\)/);
  assert.match(
    source("../app/globals.css"),
    /html\.theme-changing \*[\s\S]*transition-duration: 0s !important;[\s\S]*transition-delay: 0s !important;/,
  );
});

test("the Viewer context bar omits the share-link control", () => {
  const contextBar = source("../components/shell/ContextBar.tsx");

  assert.doesNotMatch(
    contextBar,
    /ShareViewButton|Share view|Copy link to this view|navigator\.clipboard/,
  );
});

test("the top-left Hurdle brand has no hover tooltip", () => {
  const leftRail = source("../components/shell/LeftRail.tsx");

  assert.doesNotMatch(leftRail, /Tooltip|TAGLINE/);
  assert.match(leftRail, /<Link href="\/" className="font-mono text-sm font-semibold text-foreground">/);
  assert.match(leftRail, /<Link href="\/" className="inline-flex items-center gap-1\.5 font-mono text-sm font-semibold text-foreground">/);
});

test("the app shell pins the rail footer while only the content pane scrolls", () => {
  const layout = source("../app/layout.tsx");
  const shell = source("../components/shell/ResizableAppShell.tsx");
  const sidebarShell = source("../components/shell/ResizableSidebarShell.tsx");
  const rail = source("../components/shell/LeftRail.tsx");
  const footer = source("../components/shell/SidebarFooter.tsx");
  const credit = source("../components/shell/TogetherCredit.tsx");

  assert.match(layout, /<body className="h-full overflow-hidden flex flex-col">/);
  assert.match(
    sidebarShell,
    /className="h-screen w-full overflow-hidden bg-canvas text-foreground"/,
  );
  assert.match(
    shell,
    /contentClassName="overflow-y-auto"/,
  );
  assert.equal((rail.match(/hidden h-full w-full/g) ?? []).length, 2);
  assert.doesNotMatch(rail, /sticky top-0/);
  assert.match(
    footer,
    /flex shrink-0 flex-wrap items-center justify-between/,
  );
  assert.match(credit, /inline-flex items-center gap-2 text-\[11px\]/);
  assert.match(credit, /src="\/together-logo-light\.png"[\s\S]*dark:hidden/);
  assert.match(credit, /src="\/together-logo\.png"[\s\S]*hidden h-4[\s\S]*dark:block/);
  assert.doesNotMatch(credit, /brightness-0|dark:invert/);
});

test("the local Viewer never advertises the removed docs-candidates route", () => {
  assert.doesNotMatch(source("../components/shell/LeftRail.tsx"), /docs-candidates|showDocsCandidates/);
});

test("deterministic checks expose one Shiki-highlighted evaluator drawer", () => {
  const sessionReview = source("../components/CanonicalSessionReview.tsx");
  const drawer = source("../components/canonical/EvaluatorSourceDrawer.tsx");
  const styles = source("../app/globals.css");
  const sessionPage = source("../app/s/[id]/page.tsx");
  const route = source("../app/api/runs/[id]/evaluator-source/route.ts");

  assert.match(drawer, /@base-ui\/react\/drawer/);
  assert.match(drawer, /highlightCheckSource/);
  assert.match(drawer, /swipeDirection="right"/);
  assert.match(drawer, /View check code/);
  assert.match(drawer, /inline-flex h-8/);
  assert.doesNotMatch(drawer, /min-h-10/);
  assert.match(drawer, /evaluator-source-backdrop/);
  assert.match(drawer, /evaluator-source-drawer/);
  assert.match(styles, /\.evaluator-source-backdrop[\s\S]*background: #18181b;[\s\S]*opacity: calc\(\.18 \* \(1 - var\(--drawer-swipe-progress, 0\)\)\);[\s\S]*transition: opacity 260ms ease;/);
  assert.match(styles, /\.evaluator-source-drawer[\s\S]*transition: transform 300ms cubic-bezier\(\.32, \.72, 0, 1\);/);
  assert.doesNotMatch(drawer, /Evaluator source files|Entry module|sources\.map/);
  assert.doesNotMatch(drawer, /bg-\[#090a0b\]|text-\[#d7dae0\]/);
  assert.match(drawer, /Exact source captured with this run/);
  assert.match(drawer, /aria-label="Close evaluator source"/);
  assert.match(sessionReview, /EvaluatorSourceDrawer/);
  assert.equal((sessionReview.match(/<EvaluatorSourceDrawer/g) ?? []).length, 1);
  assert.doesNotMatch(sessionReview, /Select a check to view code/);
  assert.doesNotMatch(sessionReview, /group\/check/);
  assert.match(sessionReview, /Evaluator source wasn&apos;t captured with this run/);
  assert.match(sessionPage, /evaluatorSources=\{evaluatorSources\}/);
  assert.match(route, /readEvaluatorSource/);
  assert.doesNotMatch(route, /readFile|evals|process\.cwd/);

  assert.equal(existsSync(new URL("../app/api/runs/[id]/evaluator-source/route.ts", import.meta.url)), true);
});

test("check cards show outcomes and explanations without raw evidence fingerprints", () => {
  const review = source("../components/CanonicalSessionReview.tsx");
  assert.doesNotMatch(review, /Evidence:|check\.evidenceRefs/);
  assert.match(review, /OUTCOME_STYLE\[check\.outcome\]/);
  assert.match(review, /\{check\.summary\}/);
  assert.match(review, /EvaluatorSourceDrawer/);
  // Hiding the display must not strip the evidence references from the stored checks.
  assert.match(source("../lib/canonical-dashboard-projection.mjs"), /storedChecks: record\.state === "complete" \? record\.checks : \[\]/);
});

test("a canonical Local Result Store that has no runs renders an actionable empty state", () => {
  const store = source("../lib/canonical-store.server.ts");
  const dashboardSource = source("../lib/canonical-dashboard-results.server.ts");
  const detailSource = source("../lib/canonical-results.server.ts");
  assert.match(store, /status: "empty"/);
  assert.match(store, /ENOENT/);
  assert.match(store, /source\.status === "empty" \? undefined : pending/);
  assert.match(dashboardSource, /source\.status === "empty" \? undefined : pending/);
  assert.match(detailSource, /source\.status === "empty" \? undefined : pending/);

  const home = source("../app/page.tsx");
  assert.match(home, /canonicalSource\.status === "empty"/);
  assert.match(home, /<GettingStarted steps=\{onboarding\?\.steps\}/);
});

test("the session highlights use a roomy two-by-two layout inside the narrow detail column", () => {
  const summary = source("../components/SessionReviewSummary.tsx");

  assert.doesNotMatch(summary, /lg:grid-cols-5/);
  assert.match(summary, /sm:grid-cols-6/);
  assert.equal((summary.match(/sm:col-span-2/g) ?? []).length, 0);
  assert.equal((summary.match(/sm:col-span-3/g) ?? []).length, 4);
  assert.equal((summary.match(/sm:border-r/g) ?? []).length, 2);
  assert.match(summary, /px-5 py-5/);
  assert.match(summary, /rounded-lg border border-rule/);
  assert.doesNotMatch(summary, /rounded-xl/);
  assert.doesNotMatch(summary, /Deep Audit/);
  assert.match(summary, /\n\s+Judge\n/);
  assert.match(summary, /judgeStatusLabel/);
});

test("the version selector trails each selected row with its checkmark", () => {
  const combobox = source("../components/ui/VersionCombobox.tsx");
  const label = combobox.indexOf('<span className="min-w-0 flex-1">');
  const indicator = combobox.indexOf('<Combobox.ItemIndicator className="shrink-0">');

  assert.ok(label >= 0, "version option label must exist");
  assert.ok(indicator > label, "selected checkmark must follow the version label");
});

test("session tabs expose stable shareable URL hashes", () => {
  const tabs = source("../components/SessionDetailTabs.tsx");

  for (const [tab, hash] of [
    ["review", "#review"],
    ["evidence", "#evidence"],
    ["transcript", "#conversation"],
  ]) {
    assert.match(tabs, new RegExp(`${tab}: "${hash}"`));
  }
  assert.match(tabs, /window\.history\.replaceState/);
  assert.match(tabs, /onClick=\{\(\) => selectTab\(tab\.key\)\}/);
  assert.doesNotMatch(tabs, /Improvements|#improvements|#suggestions/);
  assert.doesNotMatch(tabs, /shadow-sm/);
});

test("surface depth uses a quiet canvas, single borders, and restrained floating shadows", () => {
  const styles = source("../app/globals.css");
  const versionCombobox = source("../components/ui/VersionCombobox.tsx");
  const exportMenu = source("../components/ui/ExportMenu.tsx");

  assert.match(styles, /--canvas:\s+var\(--background\)/);
  assert.match(styles, /--canvas:\s+oklch\(0\.125 0\s+0\)/);
  assert.match(styles, /--rule:\s+oklch\(1 0 0 \/ 10%\)/);
  assert.match(versionCombobox, /border border-rule bg-background shadow-xs/);
  assert.match(exportMenu, /border border-rule bg-background shadow-xs/);
});

test("Viewer buttons use color feedback without press-scale motion", () => {
  for (const path of [
    "../components/ScrollToTop.tsx",
    "../components/SessionDetailTabs.tsx",
  ]) {
    assert.doesNotMatch(source(path), /active:scale|transition-transform|box-shadow,scale/);
  }
});

test("button feedback is immediate and has no press movement", () => {
  const styles = source("../app/globals.css");

  assert.match(
    styles,
    /button,\s*\n\s*button \*[\s\S]*transition-duration: 0s !important;[\s\S]*transition-delay: 0s !important;/,
  );
});

test("the check-code drawer resizes from its left edge", () => {
  const drawer = source("../components/canonical/EvaluatorSourceDrawer.tsx");
  const styles = source("../app/globals.css");

  assert.match(drawer, /aria-label="Resize check code panel"/);
  assert.match(drawer, /role="separator"/);
  assert.match(drawer, /onPointerDown=\{startResize\}/);
  assert.match(drawer, /onKeyDown=\{resizeWithKeyboard\}/);
  assert.match(drawer, /MIN_DRAWER_WIDTH = 420/);
  assert.match(drawer, /MAX_DRAWER_WIDTH = 1_200/);
  assert.match(drawer, /DRAWER_WIDTH_STORAGE_KEY = "hurdle-check-code-drawer-width"/);
  assert.match(drawer, /readStoredWidth/);
  assert.match(drawer, /writeStoredWidth/);
  assert.match(styles, /\.evaluator-source-resizer[\s\S]*cursor: col-resize/);
  assert.match(styles, /\.evaluator-source-resizer::before[\s\S]*width: 20px/);
  assert.match(drawer, /aria-label="Close evaluator source"[\s\S]*rounded-md text-fg-muted/);
  assert.doesNotMatch(drawer, /aria-label="Close evaluator source"[\s\S]{0,240}border border-rule/);
});

test("the transcript sidebar uses the shared resizable panel interaction", () => {
  const shell = source("../components/ResizableSessionShell.tsx");
  const sidebarShell = source("../components/shell/ResizableSidebarShell.tsx");
  const session = source("../app/s/[id]/page.tsx");
  const sidebar = source("../components/SessionSidebar.tsx");
  const storage = source("../lib/browser-layout-storage.ts");

  assert.match(shell, /<ResizableSidebarShell/);
  assert.match(sidebarShell, /minSize=\{MIN_SIDEBAR_WIDTH\}/);
  assert.match(sidebarShell, /maxSize=\{MAX_SIDEBAR_WIDTH\}/);
  assert.match(shell, /resizeLabel="Resize transcript sidebar"/);
  assert.match(storage, /SIDEBAR_WIDTH_STORAGE_KEY = "hurdle-sidebar-width"/);
  assert.match(sidebarShell, /writeStoredWidth/);
  assert.match(shell, /<SessionSidebar messages=\{messages\}/);
  assert.match(session, /readSidebarLayout\(/);
  assert.match(session, /initialRailWidth=\{sidebarLayout\.width\} initialRailCollapsed=\{sidebarLayout\.collapsed\}/);
  assert.match(sidebar, /<SidebarToggle/);
  assert.doesNotMatch(session, /<SessionSidebar/);
  assert.doesNotMatch(sidebar, /w-80|min-w-72/);
});

test("resizable app layouts persist user-adjusted widths", () => {
  const appShell = source("../components/shell/ResizableAppShell.tsx");
  const sidebarShell = source("../components/shell/ResizableSidebarShell.tsx");
  const storage = source("../lib/browser-layout-storage.ts");

  assert.match(appShell, /<ResizableSidebarShell/);
  assert.match(sidebarShell, /readStoredWidth/);
  assert.match(sidebarShell, /writeStoredWidth/);
  assert.match(sidebarShell, /readStoredBoolean/);
  assert.match(sidebarShell, /writeStoredBoolean/);
  assert.match(sidebarShell, /if \(!isUserInteraction/);
  assert.match(sidebarShell, /size\.inPixels <= COLLAPSED_SIDEBAR_WIDTH \+ 1/);
  assert.match(storage, /SIDEBAR_COLLAPSED_STORAGE_KEY = "hurdle-sidebar-collapsed"/);
  assert.match(storage, /typeof window === "undefined"/);
  assert.match(storage, /readStoredPreference\(window\.localStorage, key\)/);
  assert.match(storage, /window\.localStorage\.setItem/);
  assert.match(storage, /document\.cookie/);
  assert.match(storage, /export function parseStoredWidth/);
  assert.match(storage, /export function readStoredBoolean/);
  assert.match(storage, /export function writeStoredBoolean/);
});

test("transcript message anchors share the role label's optical center", () => {
  const conversation = source("../components/ConversationView.tsx");

  assert.match(
    conversation,
    /top-2 inline-flex -translate-y-1\/2 items-center text-\[10px\] leading-none/,
  );
  assert.match(
    conversation,
    /text-\[10px\] font-semibold uppercase leading-none tracking-\[0\.08em\]/,
  );
});
