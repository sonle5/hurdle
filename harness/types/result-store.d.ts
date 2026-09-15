import type { JsonObject, JsonValue } from "./json";
import type { RunDefinitionSnapshotV2 } from "./run-plan";

export type RunId = `run_${string}`;
export type Fingerprint = `sha256:${string}`;
export type RunState = "queued" | "running" | "complete";
export type RunVerdict = "pass" | "fail" | "incomplete" | "unknown";
export type JudgeStatus = "not_requested" | "pending" | "complete" | "failed";

export interface JudgeBasisV1 {
  readonly sourceRevision: 2;
  readonly snapshotFingerprint: Fingerprint;
  readonly rubricSha256: Fingerprint;
  readonly inputSha256: Fingerprint;
}

export interface JudgeResultV1 {
  readonly schemaVersion: 1;
  readonly kind: "result";
  readonly basis: JudgeBasisV1;
  readonly outcome: "pass" | "fail" | "incomplete";
  readonly summary: string;
  readonly judgeId: string;
  readonly model: string | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
}

export interface JudgeErrorV1 {
  readonly schemaVersion: 1;
  readonly kind: "error";
  readonly basis: JudgeBasisV1;
  readonly code:
    | "judge.cancelled"
    | "judge.timed-out"
    | "judge.provider-failed"
    | "judge.invalid-output"
    | "judge.input-unavailable";
  readonly message: string;
  readonly judgeId: string;
  readonly model: string | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
}

export interface JudgeBasisV2 {
  readonly schemaVersion: 2;
  readonly sourceRevision: 2;
  readonly snapshotFingerprint: Fingerprint;
  readonly authorityProfileId: string;
  readonly rubricSha256: Fingerprint;
  readonly inputSha256: Fingerprint;
  readonly judgeId: string;
  readonly model: string | null;
}

export interface JudgeResultV2 {
  readonly schemaVersion: 2;
  readonly kind: "result";
  readonly basis: JudgeBasisV2;
  readonly outcome: "pass" | "fail" | "incomplete";
  readonly summary: string;
  readonly judgeId: string;
  readonly model: string | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
}

export interface JudgeErrorV2 {
  readonly schemaVersion: 2;
  readonly kind: "error";
  readonly basis: JudgeBasisV2;
  readonly code:
    | "judge.cancelled"
    | "judge.timed-out"
    | "judge.provider-failed"
    | "judge.invalid-output"
    | "judge.input-unavailable";
  readonly message: string;
  readonly judgeId: string;
  readonly model: string | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
}

/** Compatibility names for the Record v2 Judge contract. */
export type JudgeBasis = JudgeBasisV1;
export type JudgeResult = JudgeResultV1;
export type JudgeError = JudgeErrorV1;
export type StoredJudgeBasis = JudgeBasisV1 | JudgeBasisV2;
export type StoredJudgeV1 = JudgeResultV1 | JudgeErrorV1;
export type StoredJudgeV2 = JudgeResultV2 | JudgeErrorV2;
export type StoredJudge = StoredJudgeV1 | StoredJudgeV2;

export interface EvidenceReference {
  readonly runId: RunId;
  readonly key: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: Fingerprint;
  readonly provenance: string;
  readonly authority: string;
  readonly producer: string;
  readonly lifecyclePhase: string;
  readonly capturedAt: string;
  readonly trust: string;
  readonly availability: "available" | "unavailable";
}

export interface DeterministicCheckV2 {
  readonly id: string;
  readonly required: boolean;
  readonly outcome: "pass" | "fail" | "skip";
  readonly summary: string;
  readonly evidenceRefs: readonly Fingerprint[];
  readonly details?: JsonValue;
}

export interface DeterministicCheckV3 {
  readonly id: string;
  readonly authoredAuthority: "required" | "advisory";
  readonly effectiveAuthority: "required" | "advisory" | "disabled";
  readonly outcome: "pass" | "fail" | "skip";
  readonly summary: string;
  readonly evidenceRefs: readonly Fingerprint[];
  readonly details?: JsonValue;
}

/** Raw Deterministic Evaluator output and the stored Record v2 shape. */
export type DeterministicCheck = DeterministicCheckV2;
export type StoredDeterministicCheck = DeterministicCheckV2 | DeterministicCheckV3;

export interface VerdictReason {
  readonly code: string;
  readonly summary: string;
  readonly evidenceRefs: readonly Fingerprint[];
}

export interface IntegrityIssue {
  readonly code: string;
  readonly phase: string;
  readonly effect: "incomplete" | "unknown";
  readonly message: string;
}

export interface FixedRetryPolicy {
  readonly kind: "fixed-execution-failures-v1";
  readonly maxRetries: number;
  readonly retryableIssueCodes: readonly string[];
  readonly blockingIssueCodes: readonly string[];
}

export interface RunInvocation {
  readonly groupId: string;
  readonly ordinal: number;
  readonly total: number;
  readonly repeatOrdinal: number;
  readonly repeatTotal: number;
  readonly retryPolicy: FixedRetryPolicy;
  readonly attemptOrdinal: number;
  readonly rootRunId: RunId;
  readonly retryOf: RunId | null;
  readonly retryTrigger: string | null;
}

export interface RunDefinitionSnapshotV1 {
  readonly schemaVersion: 1;
  readonly target: Readonly<{
    id: string;
    displayName: string;
    [key: string]: JsonValue;
  }>;
  readonly task: Readonly<{
    id: string;
    [key: string]: JsonValue;
  }>;
  readonly condition: Readonly<{
    id: string;
    definition: JsonObject;
  }>;
  readonly behavior: JsonObject;
  readonly agent: Readonly<{
    adapterId: string;
    requestedModel: string | null;
    settings: JsonObject;
  }>;
  readonly environment: Readonly<{
    environmentId: string;
    settings: JsonObject;
  }>;
}

export type RunDefinitionSnapshot =
  | RunDefinitionSnapshotV1
  | RunDefinitionSnapshotV2;

export interface ExecutionFacts {
  readonly adapterId: string;
  readonly environmentId: string;
  readonly requestedModel: string | null;
  readonly observedModel: string | null;
  readonly sessionId: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
}

export interface CapturedArtifactManifestEntry {
  readonly path: string;
  readonly kind: "text" | "binary";
  readonly maxBytes: number;
  readonly required: boolean;
  readonly status: "captured";
  readonly sizeBytes: number;
  readonly sha256: Fingerprint;
  readonly textEncoding?: string;
  readonly provenance: string;
  readonly authority: string;
  readonly producer: string;
  readonly lifecyclePhase: string;
  readonly capturedAt: string;
  readonly trust: string;
  readonly content: EvidenceReference;
}

export interface UncapturedArtifactManifestEntry {
  readonly path: string;
  readonly kind: "text" | "binary";
  readonly maxBytes: number;
  readonly required: boolean;
  readonly status: "missing" | "rejected";
  readonly reason: string | null;
  readonly provenance: string;
  readonly authority: string;
  readonly producer: string;
  readonly lifecyclePhase: string;
  readonly capturedAt: string;
  readonly trust: string;
  readonly content: null;
}

export type ArtifactManifestEntry =
  | CapturedArtifactManifestEntry
  | UncapturedArtifactManifestEntry;

export interface EgressManifestEntry {
  readonly status: "captured" | "unavailable";
  readonly reason?: string;
  readonly provenance: Readonly<{
    producer: string;
    authority: string;
    lifecyclePhase: string;
    capturedAt: string;
    trust: string;
  }>;
  readonly content: EvidenceReference;
}

export interface RunEvidenceManifest {
  readonly transcript: EvidenceReference | null;
  readonly stderr: EvidenceReference | null;
  readonly structured: readonly EvidenceReference[];
  readonly artifacts: readonly ArtifactManifestEntry[];
  readonly egress: readonly EgressManifestEntry[];
  readonly lifecycle?: Readonly<Record<
    string,
    EvidenceReference | readonly EvidenceReference[]
  >>;
}

export interface StoredOutcome {
  readonly verdict: RunVerdict;
  readonly verdictReasons: readonly VerdictReason[];
}

export interface StoredHeadline extends StoredOutcome {
  readonly decidedBy:
    | "mandatory-run-trust"
    | "effective-deterministic"
    | "judge"
    | "observation";
}

export interface RunTrustAssessmentV1 {
  readonly schemaVersion: 1;
  readonly status: "trusted" | "incomplete" | "unknown";
  readonly reasons: readonly VerdictReason[];
}

export type EvaluatorStatusV3 =
  | "not_configured"
  | "complete"
  | "failed"
  | "blocked_by_run_trust"
  | "invalid_output";

export interface DeterministicAssessmentV3 {
  readonly evaluatorStatus: EvaluatorStatusV3;
  readonly baseline: StoredOutcome | null;
  readonly effective: StoredOutcome | null;
}

export interface RunMetrics {
  readonly common: JsonObject;
  readonly adapters: Readonly<Record<string, JsonObject>>;
  readonly targets: Readonly<Record<string, JsonObject>>;
}

export interface RunRecordBaseV2 {
  readonly schemaVersion: 2;
  readonly id: RunId;
  readonly revision: number;
  readonly snapshot: RunDefinitionSnapshotV1;
  readonly snapshotFingerprint: Fingerprint;
  readonly experimentVersion: string | null;
  readonly invocation: RunInvocation;
  readonly createdAt: string;
  readonly state: RunState;
  readonly verdict: RunVerdict | null;
  readonly judgeStatus: JudgeStatus;
}

export interface QueuedRunRecordV2 extends RunRecordBaseV2 {
  readonly state: "queued";
  readonly verdict: null;
  readonly judgeStatus: "not_requested";
  readonly judge: null;
}

export interface RunningRunRecordV2 extends RunRecordBaseV2 {
  readonly state: "running";
  readonly verdict: null;
  readonly judgeStatus: "not_requested";
  readonly judge: null;
  readonly startedAt: string;
}

export interface CompleteRunRecordV2 extends RunRecordBaseV2 {
  readonly state: "complete";
  readonly verdict: RunVerdict;
  readonly judge: StoredJudgeV1 | null;
  readonly verdictReasons: readonly VerdictReason[];
  readonly startedAt: string | null;
  readonly completedAt: string;
  readonly execution: ExecutionFacts;
  readonly metrics: RunMetrics;
  readonly integrityIssues: readonly IntegrityIssue[];
  readonly evidence: RunEvidenceManifest;
  readonly checks: readonly DeterministicCheckV2[];
}

export type RunRecordV2 =
  | QueuedRunRecordV2
  | RunningRunRecordV2
  | CompleteRunRecordV2;

export interface RunRecordBaseV3 {
  readonly schemaVersion: 3;
  readonly id: RunId;
  readonly revision: 0 | 1 | 2 | 3 | 4;
  readonly snapshot: RunDefinitionSnapshotV2;
  readonly snapshotFingerprint: Fingerprint;
  readonly experimentVersion: string | null;
  readonly invocation: RunInvocation;
  readonly createdAt: string;
  readonly state: RunState;
  readonly headline: StoredHeadline | null;
  readonly verdict: RunVerdict | null;
  readonly judgeStatus: JudgeStatus;
}

export interface QueuedRunRecordV3 extends RunRecordBaseV3 {
  readonly revision: 0;
  readonly state: "queued";
  readonly headline: null;
  readonly verdict: null;
  readonly judgeStatus: "not_requested";
  readonly judge: null;
}

export interface RunningRunRecordV3 extends RunRecordBaseV3 {
  readonly revision: 1;
  readonly state: "running";
  readonly headline: null;
  readonly verdict: null;
  readonly judgeStatus: "not_requested";
  readonly judge: null;
  readonly startedAt: string;
}

export interface CompleteRunRecordV3Data extends RunRecordBaseV3 {
  readonly revision: 2 | 3 | 4;
  readonly state: "complete";
  readonly headline: StoredHeadline;
  readonly verdict: RunVerdict;
  readonly verdictReasons: readonly VerdictReason[];
  readonly runTrust: RunTrustAssessmentV1;
  readonly deterministic: DeterministicAssessmentV3;
  readonly startedAt: string | null;
  readonly completedAt: string;
  readonly execution: ExecutionFacts;
  readonly metrics: RunMetrics;
  readonly integrityIssues: readonly IntegrityIssue[];
  readonly evidence: RunEvidenceManifest;
  readonly checks: readonly DeterministicCheckV3[];
}

export type CompleteRunRecordV3 =
  | (CompleteRunRecordV3Data & Readonly<{
      revision: 2;
      judgeStatus: "not_requested";
      judge: null;
    }>)
  | (CompleteRunRecordV3Data & Readonly<{
      revision: 3;
      judgeStatus: "pending";
      judge: null;
    }>)
  | (CompleteRunRecordV3Data & Readonly<{
      revision: 4;
      judgeStatus: "complete";
      judge: JudgeResultV2;
    }>)
  | (CompleteRunRecordV3Data & Readonly<{
      revision: 4;
      judgeStatus: "failed";
      judge: JudgeErrorV2;
    }>);

export type RunRecordV3 =
  | QueuedRunRecordV3
  | RunningRunRecordV3
  | CompleteRunRecordV3;

export type QueuedRunRecord = QueuedRunRecordV2 | QueuedRunRecordV3;
export type RunningRunRecord = RunningRunRecordV2 | RunningRunRecordV3;
export type CompleteRunRecord = CompleteRunRecordV2 | CompleteRunRecordV3;
export type RunRecordBase = RunRecordBaseV2 | RunRecordBaseV3;
export type RunRecord = RunRecordV2 | RunRecordV3;

export interface ResultStoreQuery {
  readonly limit?: number;
  readonly targetId?: string;
}

export interface ResultStore {
  getRun(id: RunId): Promise<RunRecord | null>;
  getRunHistory(id: RunId): Promise<readonly RunRecord[]>;
  listRuns(query?: ResultStoreQuery): Promise<readonly RunRecord[]>;
  readEvidence(
    reference: EvidenceReference,
    options: Readonly<{ maxBytes: number }>,
  ): Promise<Uint8Array>;
}

export function openLocalResultStoreReader(
  options: Readonly<{ root: string }>,
): Promise<ResultStore>;

export function openLocalResultStore(
  options: Readonly<{ root: string }>,
): Promise<ResultStore>;
