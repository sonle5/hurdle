import { RunSelectionInputError } from "./run-model.mjs";

export function selectSuiteAgents(agents, { agent, model } = {}) {
  const selected = agents.filter(value => agent === undefined || value.adapterId === agent);
  if (!selected.length) throw new RunSelectionInputError("No Suite Agent matches the selected Agent filter.");
  if (model === undefined) return selected;
  if (typeof model !== "string" || !model.trim()) throw new RunSelectionInputError("--model requires a nonblank model ID.");
  if (new Set(selected.map(value => value.adapterId)).size > 1) {
    throw new RunSelectionInputError("Use --agent claude-code or --agent codex with --model when the Suite defines both runners.");
  }
  // Preserve effort variants. Collapsing models may produce identical selections;
  // avoid running those cells twice while retaining the Run Engine's duplicate guard.
  const overridden = selected.map(value => ({ ...value, requestedModel: model.trim() }));
  return [...new Map(overridden.map(value => [JSON.stringify(value), value])).values()];
}
