import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("the home leaderboard keeps four run KPIs and omits review summaries", () => {
  const leaderboard = source("../components/leaderboard/Leaderboard.tsx");
  assert.match(leaderboard, /label: "Runs"/);
  assert.match(leaderboard, /label: "Strict pass"/);
  assert.match(leaderboard, /label: "Avg duration"/);
  assert.match(leaderboard, /label: "Avg cost"/);
  assert.doesNotMatch(leaderboard, /label: "Reviewed"/);
  assert.doesNotMatch(leaderboard, /ReviewedAttributionBreakdown/);
  assert.doesNotMatch(leaderboard, /AutomatedTriageBreakdown/);
});

test("home task definitions are limited to two readable lines", () => {
  const leaderboard = source("../components/leaderboard/Leaderboard.tsx");
  assert.match(leaderboard, /line-clamp-2/);
  assert.match(leaderboard, /text-pretty/);
});

test("a bare leaderboard URL defaults to separately scored model sections", () => {
  const page = source("../app/page.tsx");
  const leaderboard = source("../components/leaderboard/Leaderboard.tsx");
  const taskPage = source("../app/t/[slug]/page.tsx");

  assert.match(page, /const defaultModel = "all"/);
  assert.match(leaderboard, /const modelFilter = modelParam \|\| "all"/);
  assert.match(taskPage, /const modelFilter = sp\.model \?\? "all"/);
  assert.doesNotMatch(page, /sortedModels\[0\]/);
  assert.doesNotMatch(leaderboard, /models\[0\]/);
});
