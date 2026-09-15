import type { JsonObject, JsonValue } from "./json";
import type { EgressEvidenceCollection } from "./egress-evidence";
import type {
  DeterministicCheck,
  Fingerprint,
  RunDefinitionSnapshot,
} from "./result-store";

export type MissingArtifactRead = Readonly<{ status: "missing" }>;

export type TextArtifactRead =
  | MissingArtifactRead
  | Readonly<{
      status: "invalid_utf8";
      sha256: Fingerprint;
    }>
  | Readonly<{
      status: "present";
      text: string;
      sha256: Fingerprint;
      evidenceRef: Fingerprint;
    }>;

export type BinaryArtifactRead =
  | MissingArtifactRead
  | Readonly<{
      status: "present";
      bytes: Uint8Array;
      sha256: Fingerprint;
      evidenceRef: Fingerprint;
    }>;

export interface DeterministicEvaluatorAssertions {
  createCheck(input: Readonly<{
    id: string;
    valid: boolean;
    passSummary: string;
    failSummary: string;
    evidenceRefs?: readonly (Fingerprint | null | undefined)[];
    required?: boolean;
  }>): DeterministicCheck;
  detectImageFormat(bytes: Uint8Array): "png" | "jpeg" | "webp" | null;
  hasExactObjectKeys(
    value: unknown,
    required: readonly string[],
    optional?: readonly string[],
  ): boolean;
  isSuccessfulHttpStatus(statusCode: unknown): boolean;
  matchesBytes(
    bytes: Uint8Array,
    offset: number,
    expected: string | readonly number[],
  ): boolean;
  parseJsonArtifact(result: TextArtifactRead): JsonValue | null;
}

export interface DeterministicEvaluatorInput {
  readonly snapshot: RunDefinitionSnapshot;
  readonly transcript: JsonValue;
  readonly execution: JsonObject;
  readonly egress: readonly EgressEvidenceCollection[];
  readonly lifecycle: Readonly<Record<string, JsonValue>>;
  readonly assertions: DeterministicEvaluatorAssertions;
  readArtifactText(path: string): TextArtifactRead;
  readArtifactBytes(path: string): BinaryArtifactRead;
}

export interface DeterministicEvaluation {
  readonly checks: readonly DeterministicCheck[];
  readonly targetMetrics: JsonObject;
}

export type DeterministicEvaluator = (
  input: Readonly<DeterministicEvaluatorInput>,
) => DeterministicEvaluation | Promise<DeterministicEvaluation>;
