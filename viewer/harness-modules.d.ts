declare module "@harness/local-result-store" {
  export {
    openLocalResultStoreReader,
  } from "../harness/types/result-store";
  export type {
    ResultStore,
    ResultStoreQuery,
    RunRecord,
  } from "../harness/types/result-store";
}

declare module "@harness/postgres-result-store-reader" {
  export {
    openPostgresResultStoreReader,
  } from "../harness/types/postgres-result-store-reader";
  export type {
    ResultStore,
    ResultStoreQuery,
    RunRecord,
  } from "../harness/types/result-store";
}
