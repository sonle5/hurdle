import "server-only";

import {
  createCanonicalDashboardProjection,
} from "./canonical-dashboard-projection.mjs";
import { getCanonicalStoreSource } from "./canonical-store.server";

type CanonicalDashboardProjection = ReturnType<typeof createCanonicalDashboardProjection>;

export type CanonicalDashboardSource =
  | Readonly<{ status: "ready"; projection: CanonicalDashboardProjection }>
  | Readonly<{ status: "unconfigured" }>
  | Readonly<{ status: "empty"; root: string }>;

let cachedSource: Promise<CanonicalDashboardSource> | undefined;

async function openSource(): Promise<CanonicalDashboardSource> {
  const source = await getCanonicalStoreSource();
  if (source.status !== "ready") return source;
  return {
    status: "ready",
    projection: createCanonicalDashboardProjection(source.reader),
  };
}

export async function getCanonicalDashboardSource(): Promise<CanonicalDashboardSource> {
  const pending = cachedSource ?? openSource();
  const source = await pending;
  cachedSource = source.status === "empty" ? undefined : pending;
  return source;
}
