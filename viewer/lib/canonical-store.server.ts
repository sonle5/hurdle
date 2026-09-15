import "server-only";

import { isAbsolute } from "node:path";
import { openLocalResultStoreReader } from "@harness/local-result-store";
import { openPostgresResultStoreReader } from "@harness/postgres-result-store-reader";

type LocalReader = Awaited<ReturnType<typeof openLocalResultStoreReader>>;
type PostgresReader = Awaited<ReturnType<typeof openPostgresResultStoreReader>>;

export type CanonicalStoreSource =
  | Readonly<{ status: "ready"; reader: LocalReader | PostgresReader }>
  | Readonly<{ status: "unconfigured" }>
  | Readonly<{ status: "empty"; root: string }>;

let cachedSource: Promise<CanonicalStoreSource> | undefined;

async function openConfiguredSource(): Promise<CanonicalStoreSource> {
  const configuredMode = process.env.TAE_RESULT_STORE_MODE?.trim();
  const root = process.env.TAE_RESULT_STORE_ROOT?.trim();
  const mode = configuredMode || (root ? "local" : undefined);
  if (!mode) return { status: "unconfigured" };
  if (mode === "postgres") {
    const connectionString = process.env.TAE_RESULT_STORE_DATABASE_URL?.trim();
    if (!connectionString) {
      throw new TypeError(
        "TAE_RESULT_STORE_DATABASE_URL is required when TAE_RESULT_STORE_MODE=postgres",
      );
    }
    return {
      status: "ready",
      reader: await openPostgresResultStoreReader({ connectionString }),
    };
  }
  if (mode !== "local") {
    throw new TypeError("TAE_RESULT_STORE_MODE must be 'local' or 'postgres'");
  }
  if (!root) {
    throw new TypeError(
      "TAE_RESULT_STORE_ROOT is required when TAE_RESULT_STORE_MODE=local",
    );
  }
  if (!isAbsolute(root)) {
    throw new TypeError("TAE_RESULT_STORE_ROOT must be an absolute path");
  }
  try {
    return {
      status: "ready",
      reader: await openLocalResultStoreReader({ root }),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { status: "empty", root };
    }
    throw error;
  }
}

export async function getCanonicalStoreSource(): Promise<CanonicalStoreSource> {
  const pending = cachedSource ?? openConfiguredSource();
  const source = await pending;
  cachedSource = source.status === "empty" ? undefined : pending;
  return source;
}
