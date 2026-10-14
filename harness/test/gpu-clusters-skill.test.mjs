import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const skillRoot = new URL("../../evals/together/skills/together-ai/", import.meta.url);
const read = (path) => readFileSync(new URL(path, skillRoot), "utf8");
const router = read("SKILL.md");
const skill = read("domains/gpu-clusters.md");
const discovery = read("references/gpu-clusters/pricing-and-discovery.md");

test("GPU cluster skill routes current inventory and pricing questions", () => {
  assert.ok(router.includes("domains/gpu-clusters.md"), "missing route to the GPU cluster guide");
  for (const phrase of [
    "pricing-and-discovery.md",
    "https://www.together.ai/pricing#gpu-clusters",
    "8-GPU minimum",
    "ON_DEMAND",
  ]) {
    assert.ok(skill.includes(phrase), `missing high-signal rule: ${phrase}`);
  }
});

test("GPU cluster discovery uses separate live inventory and pricing surfaces", () => {
  for (const phrase of [
    "https://api.together.ai/v1/compute/regions",
    "tg beta clusters list-regions --json",
    "does **not** include pricing",
    "Prices are per GPU per hour",
    "multiple of 8",
    "--nvidia-driver-version",
    "--cuda-version",
    "--billing-type ON_DEMAND",
    "--cluster-type KUBERNETES",
    "--non-interactive",
    "tg beta clusters delete",
    "no cluster-create dry-run flag",
  ]) {
    assert.ok(discovery.includes(phrase), `missing discovery rule: ${phrase}`);
  }
  const createBlock = discovery.match(
    /tg beta clusters create \\\n[\s\S]*?--json/,
  )?.[0];
  assert.ok(createBlock, "missing non-interactive create command");
  assert.doesNotMatch(createBlock, /--duration-days/);
});
