import "server-only";

import {
  createCanonicalResultsClient,
  type CanonicalResultsClient,
} from "./canonical-results.mjs";
import { getCanonicalStoreSource } from "./canonical-store.server";

export type CanonicalResultsSource =
  | Readonly<{ status: "ready"; client: CanonicalResultsClient }>
  | Readonly<{ status: "unconfigured" }>
  | Readonly<{ status: "empty"; root: string }>;

async function openConfiguredSource(): Promise<CanonicalResultsSource> {
  const source = await getCanonicalStoreSource();
  if (source.status !== "ready") return source;
  return {
    status: "ready",
    client: createCanonicalResultsClient(source.reader),
  };
}

let cachedSource: Promise<CanonicalResultsSource> | undefined;

export async function getCanonicalResultsSource(): Promise<CanonicalResultsSource> {
  const pending = cachedSource ?? openConfiguredSource();
  const source = await pending;
  cachedSource = source.status === "empty" ? undefined : pending;
  return source;
}
