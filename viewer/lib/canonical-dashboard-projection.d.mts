export const MAX_CANONICAL_DASHBOARD_TRANSCRIPT_BYTES: number;

export type CanonicalDashboardRuntime = Readonly<{
  provider: string;
  label: string;
  template: string | null;
}>;

export type CanonicalDashboardVersion = Readonly<{
  id: string;
  name: string;
  description: string;
  kind: "experiment";
  runAt: string;
  createdAt: string;
  model: string;
  ccVersion: null;
}>;

export type CanonicalDashboardSessionSummary = Readonly<{
  id: string;
  canonicalRunId: string;
  sourceKind: "canonical";
  createdAt: Date;
  version: string;
  run: string;
  task: string;
  taskName: string;
  prompt: string;
  runtime: CanonicalDashboardRuntime | null;
  [key: string]: unknown;
}>;

export type CanonicalDashboardSessionDetail = CanonicalDashboardSessionSummary & Readonly<{
  readOnly: true;
  sessionJsonl: string | null;
  judgeStatusLabel: string;
  storedChecks: readonly unknown[];
  evaluatorSources: readonly Readonly<{
    path: string;
    sha256: string;
    sizeBytes: number;
    entry: boolean;
  }>[];
}>;

export type CanonicalDashboardProjection = Readonly<{
  listVersions(): Promise<readonly CanonicalDashboardVersion[]>;
  listSessions(experimentVersion: string): Promise<readonly CanonicalDashboardSessionSummary[]>;
  findSession(sessionId: string): Promise<CanonicalDashboardSessionDetail | null>;
}>;

export function createCanonicalDashboardProjection(reader: Readonly<{
  listRuns(query?: unknown): Promise<readonly unknown[]>;
  getRun(runId: string): Promise<unknown | null>;
  readEvidence(reference: unknown, options: { maxBytes: number }): Promise<Buffer>;
}>): CanonicalDashboardProjection;
