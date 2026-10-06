export type V1VerdictMode = "code" | "hybrid" | "judge";

export interface V1Agent {
  readonly runner: "claude-code" | "codex";
  readonly model?: string | null;
}

export interface V1ConditionResources {
  readonly skills?: readonly Readonly<{
    readonly name: string;
    readonly sourceDirectory: string;
  }>[];
  readonly mcpServers?: readonly Readonly<{
    readonly id: string;
    readonly transport: Readonly<{
      readonly kind: "http";
      readonly url: string;
    }>;
  }>[];
}

export interface V1SuiteBase {
  readonly api?: Readonly<{
    readonly authorizationCredential: string;
    readonly hosts: readonly string[];
  }>;
  readonly tasks: readonly `./${string}`[];
  readonly agents: readonly V1Agent[];
  readonly conditions?: Readonly<Record<string, V1ConditionResources>>;
  readonly repeats?: number;
}

export type V1Suite = V1SuiteBase & (
  | Readonly<{ verdict: "code"; judge?: never }>
  | Readonly<{
      verdict: "hybrid" | "judge";
      judge: Readonly<{ model: string }>;
    }>
);

export interface V1Check {
  readonly id: string;
  readonly passed: boolean | null;
  readonly summary: string;
  readonly required?: boolean;
  readonly evidence?: readonly (string | null)[];
}

export interface V1CheckRun {
  readonly agentReply: string | null;
  readonly evidence: Readonly<{
    transcript: string | null;
    requests: readonly Readonly<{
      method: string;
      host: string;
      path: string;
      status: number | null;
      disposition: "forwarded" | "blocked";
      evidence: string | null;
    }>[] | null;
    artifact(path: string): string | null;
  }>;
  readonly artifacts: Readonly<{
    text(path: string): string | null;
    json<T = unknown>(path: string): T | null;
  }>;
  readonly expect: Readonly<{
    completed(): void;
    replyIncludes(expected: string): void;
    request(expected: Readonly<{
      id: string;
      method: string;
      path: string;
      status: number;
      required?: boolean;
    }>): void;
    artifact(expected: Readonly<{
      id: string;
      path: string;
      format: "json" | "text";
      maxBytes: number;
      required?: boolean;
    }>): void;
    tool(name: string, expected: Readonly<{
      count: number;
      required?: boolean;
    }>): void;
  }>;
  readonly observe: Readonly<{
    request(expected: Readonly<{
      id: string;
      method: string;
      path: string;
      status: number;
    }>): void;
  }>;
  judge(rubric: string): void;
  check(check: V1Check): void;
}

export interface V1Guard {
  readonly block: Readonly<{
    request(expected: Readonly<{
      id: string;
      method: string;
      path: string;
    }>): void;
  }>;
}

export function defineSuite(suite: V1Suite): V1Suite;
export function defineChecks(checks: (run: V1CheckRun) => void): (run: V1CheckRun) => void;
export function defineGuard(guard: (guard: V1Guard) => void): (guard: V1Guard) => void;
