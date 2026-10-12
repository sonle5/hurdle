export type RunCostSource = "reported" | "estimated" | "unavailable";
export function projectRunCost(record: unknown): { costUsd: number | null; costSource: RunCostSource };
export function formatRunCost(value: number | null, source?: RunCostSource): string;
export function runCostDescription(source?: RunCostSource): string;
