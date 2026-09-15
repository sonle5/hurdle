import type { Fingerprint } from "./result-store";

export type CaptureProtocol = "http" | "https" | "ws" | "wss";
export type SelectedFieldValue = string | number | boolean | null;

export type JsonFactProjectionV1 =
  | Readonly<{ kind: "present" }>
  | Readonly<{ kind: "count"; maxItems: number }>
  | Readonly<{ kind: "sha256-string"; maxInputBytes: number }>;

export interface JsonFactSelectorV1 {
  readonly id: string;
  readonly pointer: string;
  readonly maxMatches?: number;
  readonly projection: JsonFactProjectionV1;
}

export interface ExchangeFactProfileV1 {
  readonly id: string;
  readonly match: Readonly<{
    method: string;
    statusCodes: readonly number[];
  } & (
    | { paths: readonly string[]; pathTemplates?: never }
    | { paths?: never; pathTemplates: readonly string[] }
  )>;
  readonly requestJson: readonly JsonFactSelectorV1[];
  readonly responseJson: readonly JsonFactSelectorV1[];
}

export type FactResultV1 =
  | Readonly<{ state: "absent" }>
  | Readonly<{
      state: "present";
      matches: readonly Readonly<{
        pointer: string;
        value: boolean | number | Fingerprint;
      }>[];
    }>;

export interface ExchangeFactsV1 {
  readonly schemaVersion: 1;
  readonly captureProfile: "bounded-json-exchange-facts-v1";
  readonly policyFingerprint: Fingerprint;
  readonly profileId: string;
  readonly request: Readonly<Record<string, FactResultV1>>;
  readonly response: Readonly<Record<string, FactResultV1>>;
}

export interface EgressProvenance {
  readonly producer: string;
  readonly authority: "controller" | "environment";
  readonly lifecyclePhase: "execution" | "lifecycle-hook";
  readonly capturedAt: string;
  readonly trust: "controller-observed" | "environment-observed";
}

interface EgressEvidenceBase {
  readonly sequence: number;
  readonly observedAt: string;
  readonly host: string;
  readonly path: string;
  readonly statusCode: number | null;
  readonly durationMs: number | null;
  readonly selectedFields: Readonly<Record<string, SelectedFieldValue>>;
  readonly evidenceRef: Fingerprint;
}

export interface HttpRequestEvidence extends EgressEvidenceBase {
  readonly kind: "http-request";
  readonly method: string;
  readonly scheme: "http" | "https" | null;
  readonly exchangeFacts?: ExchangeFactsV1;
}

export interface WebSocketSessionEvidence extends EgressEvidenceBase {
  readonly kind: "websocket-session";
  readonly scheme: "ws" | "wss";
  readonly statusCode: 101;
  readonly framesSent: number;
  readonly bytesSent: number;
  readonly framesReceived: number;
  readonly bytesReceived: number;
}

export type EgressEvidenceEvent = HttpRequestEvidence | WebSocketSessionEvidence;

export type EgressEvidenceCollection =
  | Readonly<{
      status: "captured";
      requests: readonly EgressEvidenceEvent[];
      provenance: EgressProvenance;
      evidenceRef: Fingerprint;
    }>
  | Readonly<{
      status: "unavailable";
      reason: "not-configured" | "unsupported-platform" | "capture-failed";
      requests: readonly [];
      provenance: EgressProvenance;
      evidenceRef: Fingerprint;
    }>;
