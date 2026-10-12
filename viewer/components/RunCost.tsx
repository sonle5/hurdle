import { formatRunCost, runCostDescription, type RunCostSource } from "@/lib/run-cost.mjs";

export function RunCost({ value, source }: { value: number | null; source?: RunCostSource }) {
  return <span title={runCostDescription(source)}>{formatRunCost(value, source)}</span>;
}
