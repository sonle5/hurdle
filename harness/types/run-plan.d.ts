import type { JsonObject, JsonValue } from "./json";

export type AuthorityKind =
  | "judge-primary"
  | "hybrid"
  | "deterministic-primary";

export type CheckAuthorityRule =
  | "authored"
  | "required"
  | "advisory"
  | "disabled";

export interface JudgeProjectionV1 {
  readonly schemaVersion: 1;
  readonly include: Readonly<{
    transcript: boolean;
    stderr: boolean;
    textArtifacts: boolean;
    egress: boolean;
    lifecycleReceipts: boolean;
    runTrustIssues: boolean;
    baselineDeterministicOutcome: boolean;
    effectiveDeterministicOutcome: boolean;
    requiredChecks: boolean;
    advisoryChecks: boolean;
  }>;
  readonly limits: Readonly<{
    maxEvidenceItems: number;
    maxEvidenceItemBytes: number;
    maxEvidenceTextBytes: number;
    maxChecks: number;
    maxRunTrustIssues: number;
    maxInputBytes: number;
  }>;
}

export interface JudgeCapabilityRequirementV1 {
  readonly judgeId: string;
  readonly model: string | null;
  readonly inputSchemaVersion: 2;
  readonly requestProtocol?: JudgeRequestProtocolV1;
}

export interface JudgeRequestProtocolV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly fingerprint: `sha256:${string}`;
  readonly requirements: readonly (
    | "controller-transcript"
    | "execution-summary"
    | "workspace-artifact-metadata"
  )[];
  readonly maxRequestBytes: number;
}

export interface JudgeCapabilityV2 {
  readonly judgeId: string;
  readonly model: string | null;
  readonly inputSchemaVersions: readonly (1 | 2)[];
  readonly maxTimeoutMs: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly requestProtocols?: readonly JudgeRequestProtocolV1[];
}

export type AuthorityJudgeBaseV1 =
  | Readonly<{ availability: "disabled" }>
  | Readonly<{
      availability: "required";
      capability: JudgeCapabilityRequirementV1;
      timeoutMs: number;
      projection: JudgeProjectionV1;
      output: Readonly<{ maxSummaryBytes: number }>;
    }>;

export interface AuthorityProfileBaseV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly kind: AuthorityKind;
  readonly checkPolicy: Readonly<{ defaultRule: CheckAuthorityRule }>;
  readonly judge: AuthorityJudgeBaseV1;
}

/** Strict hybrid: a passing code result also requires a completed passing Judge. */
export interface AuthorityProfileBaseV2 extends Omit<AuthorityProfileBaseV1, "schemaVersion" | "kind" | "judge"> {
  readonly schemaVersion: 2;
  readonly kind: "hybrid";
  readonly judge: Extract<AuthorityJudgeBaseV1, { availability: "required" }>;
}

export type AuthorityProfileBase = AuthorityProfileBaseV1 | AuthorityProfileBaseV2;

export interface TaskCheckRuleV1 {
  readonly checkId: string;
  readonly rule: CheckAuthorityRule;
}

export interface TaskAuthorityBindingV1 {
  readonly profileId: string;
  readonly rubric?: string;
  readonly checkRules: readonly TaskCheckRuleV1[];
}

export interface TaskAuthorityConfigV1 {
  readonly defaultProfileId: string;
  readonly bindings: readonly TaskAuthorityBindingV1[];
}

export interface ScoredTaskEvaluationV2 {
  readonly deterministicEvaluator?: string;
  readonly authority: TaskAuthorityConfigV1;
}

export interface TargetTaskV2 {
  readonly prompt: string;
  readonly fixtures: readonly JsonObject[];
  readonly credentialRequirements: readonly string[];
  readonly evaluation?: ScoredTaskEvaluationV2;
  readonly observationOnly?: true;
  readonly [key: string]: JsonValue | ScoredTaskEvaluationV2 | undefined;
}

export type ResolvedAuthorityJudgeV1 =
  | Readonly<{ availability: "disabled" }>
  | Readonly<{
      availability: "required";
      capability: Readonly<{
        judgeId: string;
        model: string | null;
        inputSchemaVersion: 1 | 2;
        requestProtocol?: JudgeRequestProtocolV1;
      }>;
      timeoutMs: number;
      rubric: string;
      projection: JudgeProjectionV1;
      output: Readonly<{ maxSummaryBytes: number }>;
    }>;

export interface ResolvedAuthorityProfileV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly kind: AuthorityKind;
  readonly checkPolicy: Readonly<{
    defaultRule: CheckAuthorityRule;
    rules: readonly TaskCheckRuleV1[];
    unmatchedRule: "invalidate-evaluator-output";
  }>;
  readonly judge: ResolvedAuthorityJudgeV1;
}

export interface ResolvedAuthorityProfileV2 extends Omit<ResolvedAuthorityProfileV1, "schemaVersion" | "kind" | "judge"> {
  readonly schemaVersion: 2;
  readonly kind: "hybrid";
  readonly judge: Extract<ResolvedAuthorityJudgeV1, { availability: "required" }>;
}

export type ResolvedAuthorityProfile = ResolvedAuthorityProfileV1 | ResolvedAuthorityProfileV2;

export interface RunDefinitionSnapshotV2 {
  readonly schemaVersion: 2;
  readonly manifestSchemaVersion: 1 | 2;
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
  readonly evaluation: Readonly<{
    taskKind: "scored" | "observation";
    deterministicEvaluator: string | null;
    authority: ResolvedAuthorityProfile | null;
  }>;
}

export interface AuthoritySelectionDiagnostic {
  readonly category: "selection" | "capability";
  readonly code: string;
  readonly message: string;
  readonly taskId?: string;
  readonly authorityProfileId?: string;
}

export interface RunPlanDefinition {
  readonly schemaVersion: 1 | 2;
  readonly target: JsonObject;
  readonly credentialRequirements: Readonly<Record<string, JsonObject>>;
  readonly conditions: Readonly<Record<string, JsonObject>>;
  readonly authorityProfiles?: readonly AuthorityProfileBase[];
  readonly tasks: Readonly<Record<string, Readonly<{
    evaluation?: Readonly<{
      deterministicEvaluator?: string;
      judge?: Readonly<{ rubric: string }>;
      authority?: TaskAuthorityConfigV1;
    }>;
    observationOnly?: true;
    [key: string]: unknown;
  }>>>;
  readonly [key: string]: unknown;
}

export interface RunPlan {
  readonly sourceRoot: string;
  readonly sourcePath: string;
  readonly filesByPath: Readonly<Record<string, string>>;
  readonly definition: RunPlanDefinition;
  readonly definitionFingerprint: `sha256:${string}`;
  readonly behaviorGraphsByEntry: Readonly<Record<string, readonly string[]>>;
}

export type AuthoritySelectionResult =
  | Readonly<{
      ok: true;
      value: Readonly<{
        byTaskId: Readonly<Record<string, ResolvedAuthorityProfile | null>>;
      }>;
      diagnostics: readonly [];
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly AuthoritySelectionDiagnostic[];
    }>;

export function resolveAuthoritySelections(options: Readonly<{
  definition: RunPlanDefinition;
  selectedTaskIds: readonly string[];
  authorityProfileId?: string;
  legacyJudging?: "task" | "disabled" | "required";
  judgeCapability?: JudgeCapabilityV2 | null;
}>): AuthoritySelectionResult;
