import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const skill = readFileSync(
  new URL("../../evals/together/skills/together-gpu-clusters/SKILL.md", import.meta.url),
  "utf8",
);
const discovery = readFileSync(
  new URL(
    "../../evals/together/skills/together-gpu-clusters/references/pricing-and-discovery.md",
    import.meta.url,
  ),
  "utf8",
);

test("GPU cluster skill routes current inventory and pricing questions", () => {
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
