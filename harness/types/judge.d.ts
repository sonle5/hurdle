import type {
  DeterministicCheck,
  Fingerprint,
  RunId,
  RunVerdict,
  StoredOutcome,
  VerdictReason,
} from "./result-store";
import type { AuthorityKind, CheckAuthorityRule } from "./run-plan";

export type JudgeSelection = "task" | "disabled" | "required";
export type JudgeOutcome = "pass" | "fail" | "incomplete";

export interface JudgeTextExcerpt {
  readonly content: string;
  readonly originalSizeBytes: number;
  readonly includedSizeBytes: number;
  readonly truncated: boolean;
}

export interface JudgeEvidenceItem {
  readonly kind: "transcript" | "stderr" | "artifact" | "egress" | "lifecycle";
  readonly name: string;
  readonly mediaType: string;
  readonly sha256: Fingerprint | null;
  readonly authority: string;
  readonly producer: string;
  readonly lifecyclePhase: string;
  readonly trust: string;
  readonly content: JudgeTextExcerpt | null;
  readonly omission:
    | null
    | "not_captured"
    | "binary"
    | "missing"
    | "rejected"
    | "budget_exhausted";
}

export type JudgeCheck = Pick<
  DeterministicCheck,
  "id" | "required" | "outcome" | "summary" | "evidenceRefs"
>;

export interface JudgeInputV1 {
  readonly schemaVersion: 1;
  readonly run: Readonly<{
    id: RunId;
    sourceRevision: 2;
    snapshotFingerprint: Fingerprint;
  }>;
  readonly task: Readonly<{
    id: string;
    prompt: JudgeTextExcerpt;
    conditionId: string;
  }>;
  readonly rubric: string;
  readonly deterministic: Readonly<{
    verdict: RunVerdict;
    verdictReasons: readonly VerdictReason[];
    checks: readonly JudgeCheck[];
    omittedCheckCount: number;
    integrityIssues: readonly Readonly<{
      code: string;
      phase: string;
      effect: "incomplete" | "unknown";
      message: JudgeTextExcerpt;
    }>[];
    omittedIntegrityIssueCount: number;
  }>;
  readonly evidence: readonly JudgeEvidenceItem[];
}

export interface JudgeEffectiveCheck {
  readonly id: string;
  readonly authoredAuthority: "required" | "advisory";
  readonly effectiveAuthority: Exclude<CheckAuthorityRule, "authored">;
  readonly outcome: "pass" | "fail" | "skip";
  readonly summary: string;
  readonly evidenceRefs: readonly Fingerprint[];
}

export interface JudgeOmissionSummary {
  readonly omittedCount: number;
  readonly reasons: readonly string[];
}

export interface JudgeInputV2 {
  readonly schemaVersion: 2;
  readonly run: Readonly<{
    id: RunId;
    sourceRevision: 2;
    snapshotFingerprint: Fingerprint;
  }>;
  readonly authority: Readonly<{
    profileId: string;
    kind: AuthorityKind;
  }>;
  readonly task: Readonly<{
    id: string;
    prompt: JudgeTextExcerpt;
    conditionId: string;
  }>;
  readonly rubric: string;
  readonly redaction: Readonly<{ status: "applied" }>;
  readonly deterministic: Readonly<{
    baseline: StoredOutcome | null;
    effective: StoredOutcome | null;
    checks: readonly JudgeEffectiveCheck[];
    omittedCheckCount: number;
  }>;
  readonly runTrust: Readonly<{
    status: "trusted" | "incomplete" | "unknown";
    reasons: readonly VerdictReason[];
    omittedReasonCount: number;
  }>;
  readonly evidence: readonly JudgeEvidenceItem[];
  readonly omissions: Readonly<{
    transcript: JudgeOmissionSummary;
    stderr: JudgeOmissionSummary;
    textArtifacts: JudgeOmissionSummary;
    egress: JudgeOmissionSummary;
    lifecycleReceipts: JudgeOmissionSummary;
    runTrustIssues: JudgeOmissionSummary;
    baselineDeterministicOutcome: JudgeOmissionSummary;
    effectiveDeterministicOutcome: JudgeOmissionSummary;
    requiredChecks: JudgeOmissionSummary;
    advisoryChecks: JudgeOmissionSummary;
  }>;
}

export type JudgeInput = JudgeInputV1 | JudgeInputV2;

export interface JudgeDecision {
  readonly outcome: JudgeOutcome;
  readonly summary: string;
}

interface JudgeBase {
  readonly id: string;
  readonly model: string | null;
  judge(
    input: JudgeInput,
    context: Readonly<{ signal: AbortSignal }>,
  ): Promise<JudgeDecision>;
}

/** RunPlan v1 compatibility capability. */
export interface JudgeV1 extends JudgeBase {
  readonly timeoutMs: number;
  readonly inputSchemaVersions?: readonly [1];
  readonly maxTimeoutMs?: never;
  readonly maxInputBytes?: never;
  readonly maxOutputBytes?: never;
}

/** Bounded capability matched against a selected RunPlan v2 profile. */
export interface JudgeV2 extends JudgeBase {
  readonly inputSchemaVersions: readonly (1 | 2)[];
  readonly maxTimeoutMs: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly timeoutMs?: never;
}

export type Judge = JudgeV1 | JudgeV2;
