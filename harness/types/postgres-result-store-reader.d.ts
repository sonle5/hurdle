import type { ResultStore } from "./result-store";

export type {
  EvidenceReference,
  ResultStore,
  ResultStoreQuery,
  RunRecord,
} from "./result-store";

export function openPostgresResultStoreReader(
  options: Readonly<{ connectionString: string }>,
): Promise<ResultStore>;
