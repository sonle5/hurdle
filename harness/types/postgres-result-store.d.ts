import type { ResultStore } from "./result-store";

export type {
  EvidenceReference,
  ResultStore,
  ResultStoreQuery,
  RunRecord,
} from "./result-store";

export function openPostgresResultStore(
  options: Readonly<{
    connectionString: string;
    localArtifactRoot: string;
  }>,
): Promise<ResultStore>;
