import type {
  JudgeError,
  ResultStore,
  ResultStoreQuery,
} from "@harness/local-result-store";

export type RunState = "queued" | "running" | "complete";
export type RunVerdict = "pass" | "fail" | "incomplete" | "unknown";
export type JudgeStatus = "not_requested" | "pending" | "complete" | "failed";

export type CanonicalRunQuery = ResultStoreQuery;

export type AuthorityView =
  | Readonly<{
      kind: "profile";
      label: string;
      profileId: string;
      profileKind: "judge-primary" | "hybrid" | "deterministic-primary";
    }>
  | Readonly<{
      kind: "legacy-v2" | "observation";
      label: string;
      profileId: null;
      profileKind: null;
    }>;

export type StoredOutcomeView = Readonly<{
  verdict: RunVerdict;
  verdictReasons: readonly Readonly<{
    code: string;
    summary: string;
    evidenceRefs: readonly string[];
  }>[];
}>;

export type PresentedOutcome =
  | Readonly<{ availability: "recorded"; outcome: StoredOutcomeView }>
  | Readonly<{
      availability: "unavailable";
      reason: "not-recorded-in-v2" | "not-configured" | "not-complete";
    }>;

export type PresentedRunTrust =
  | Readonly<{
      availability: "recorded";
      schemaVersion: 1;
      status: "trusted" | "incomplete" | "unknown";
      reasons: StoredOutcomeView["verdictReasons"];
    }>
  | Readonly<{
      availability: "unavailable";
      reason: "not-recorded-in-v2" | "not-complete";
    }>;

export type StoredHeadlineView = StoredOutcomeView & Readonly<{
  decidedBy:
    | "mandatory-run-trust"
    | "effective-deterministic"
    | "judge"
    | "observation"
    | "legacy-v2";
}>;

export type CanonicalRunSummary = Readonly<{
  id: string;
  revision: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  experimentVersion: string | null;
  snapshotFingerprint: string;
  target: Readonly<{ id: string; displayName: string }>;
  taskId: string;
  conditionId: string;
  adapterId: string;
  requestedModel: string | null;
  observedModel: string | null;
  environmentId: string;
  state: RunState;
  authority: AuthorityView;
  verdict: RunVerdict | null;
  judgeStatus: JudgeStatus;
  durationMs: number | null;
  commonMetrics: Readonly<Record<string, unknown>>;
  checkCounts: Readonly<{
    total: number;
    required: number;
    pass: number;
    fail: number;
    skip: number;
  }>;
  artifactCounts: Readonly<{
    total: number;
    captured: number;
    missing: number;
    rejected: number;
    contentAvailable: number;
    contentUnavailable: number;
  }>;
  integrityIssueCount: number;
}>;

export type EvidenceReferenceView = Readonly<{
  sha256: string;
  mediaType: string;
  sizeBytes: number;
  provenance: string;
  authority: string;
  producer: string;
  lifecyclePhase: string;
  capturedAt: string;
  trust: string;
  availability: "available" | "unavailable";
}>;

export type EvidenceItem = Readonly<{
  kind: "transcript" | "stderr" | "structured" | "egress" | "lifecycle";
  label: string;
  status: string | null;
  reason: string | null;
  reference: EvidenceReferenceView | null;
}>;

export type ArtifactView = Readonly<{
  path: string;
  kind: string;
  required: boolean;
  captureStatus: string;
  reason: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  contentAvailability: "available" | "unavailable" | "not_recorded";
  evidence: EvidenceReferenceView | null;
  provenance: string;
  authority: string;
  producer: string;
  lifecyclePhase: string;
  capturedAt: string;
  trust: string;
}>;

export type MetricGroup = Readonly<{
  namespace: "common" | "adapter" | "target";
  ownerId: string | null;
  items: readonly Readonly<{ name: string; value: unknown }>[];
}>;

export type CheckView = Readonly<{
  id: string;
  required: boolean;
  authoredAuthority: "required" | "advisory";
  effectiveAuthority: "required" | "advisory" | "disabled" | null;
  outcome: "pass" | "fail" | "skip";
  summary: string;
  details: unknown;
  evidenceRefs: readonly string[];
  evidence: readonly EvidenceReferenceView[];
}>;

export type JudgeBasisViewV1 = Readonly<{
  sourceRevision: 2;
  snapshotFingerprint: string;
  rubricSha256: string;
  inputSha256: string;
}>;

export type JudgeBasisViewV2 = JudgeBasisViewV1 & Readonly<{
  schemaVersion: 2;
  authorityProfileId: string;
  judgeId: string;
  model: string | null;
}>;

export type JudgeBasisView = JudgeBasisViewV1 | JudgeBasisViewV2;

export type JudgeResultView = Readonly<{
  schemaVersion: 1 | 2;
  kind: "result";
  basis: JudgeBasisView;
  outcome: "pass" | "fail" | "incomplete";
  summary: string;
  judgeId: string;
  model: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}>;

export type JudgeErrorView = Readonly<{
  schemaVersion: 1 | 2;
  kind: "error";
  basis: JudgeBasisView;
  code: JudgeError["code"];
  message: string;
  judgeId: string;
  model: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}>;

export type CanonicalJudgeView =
  | Readonly<{ status: "not_requested" | "pending" }>
  | Readonly<{ status: "complete"; result: JudgeResultView }>
  | Readonly<{ status: "failed"; error: JudgeErrorView }>;

export type CanonicalRunDetail = Readonly<{
  summary: CanonicalRunSummary;
  authority: AuthorityView;
  runTrust: PresentedRunTrust;
  deterministicBaseline: PresentedOutcome;
  deterministicEffective: PresentedOutcome;
  headline: StoredHeadlineView | null;
  judge: CanonicalJudgeView;
  verdictReasons: readonly Readonly<{
    code: string;
    summary: string;
    evidenceRefs: readonly string[];
  }>[];
  checks: readonly CheckView[];
  evaluatorSources: readonly Readonly<{
    path: string;
    sha256: string;
    sizeBytes: number;
    entry: boolean;
  }>[];
  integrityIssues: readonly Readonly<{
    code: string;
    phase: string;
    effect: string;
    message: string;
  }>[];
  evidence: readonly EvidenceItem[];
  artifacts: readonly ArtifactView[];
  metrics: readonly MetricGroup[];
  execution: Readonly<{
    adapterId: string;
    environmentId: string;
    requestedModel: string | null;
    observedModel: string | null;
    sessionId: string | null;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    startedAt: string | null;
    endedAt: string | null;
    durationMs: number | null;
  }> | null;
  invocation: Readonly<{
    groupId: string;
    ordinal: number;
    total: number;
    repeatOrdinal: number;
    repeatTotal: number;
    attemptOrdinal: number;
    rootRunId: string;
    retryOf: string | null;
    retryTrigger: string | null;
  }>;
}>;

export type CanonicalResultsClient = Readonly<{
  list(query?: CanonicalRunQuery): Promise<readonly CanonicalRunSummary[]>;
  find(id: string): Promise<CanonicalRunDetail | null>;
  readEvaluatorSource(
    id: string,
    path: string,
  ): Promise<Readonly<{ path: string; sha256: string; source: string }>>;
}>;

export function createCanonicalResultsClient(
  store: Pick<ResultStore, "listRuns" | "getRun" | "readEvidence">,
): CanonicalResultsClient;
