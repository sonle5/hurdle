import { readFileSync } from "node:fs";

import { decodeControllerJsonl } from "../controller-transcript.mjs";
import { deepFreeze, RunSelectionInputError, sha256 } from "../run-model.mjs";
import { redactSecretBytes, redactSecretText } from "../evidence-redaction.mjs";
import { isAgentEffort } from "../agent-effort.mjs";

const ALLOWED_ENVIRONMENT_NAMES = Object.freeze([
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
]);

// DeepSeek Harness reads the model from a config patch; the file lives in the
// workspace because dsh resolves --patch against its working directory.
const PATCH_PATH = ".hurdle/dsh-patch.json";

// A JSON file with the `config` block of dsh's llm-pi-ai plugin, the same
// shape as a Superharness custom provider: { "providers": { name: {...} } }.
export const DSH_PROVIDERS_ENV = "HURDLE_DSH_PROVIDERS";

// dsh's built-in provider, used when no configured provider matches.
const DEEPSEEK = Object.freeze({
  provider: "deepseek-official",
  defaultModel: "deepseek-flash",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  // Messages go to api.deepseek.com/anthropic with x-api-key; dsh's web
  // search uses a bearer token on the same host.
  route: Object.freeze({ hosts: ["api.deepseek.com"], headerNames: ["x-api-key", "authorization"] }),
});

// The header each pi-ai API sends its key in.
const API_HEADERS = Object.freeze({
  "openai-completions": ["authorization"],
  "openai-responses": ["authorization"],
  "anthropic-messages": ["x-api-key", "authorization"],
  "google-generative-ai": ["x-goog-api-key"],
});

// dsh reasoning levels for deepseek-official are off, low, high, and max.
const REASONING_EFFORT = Object.freeze({
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
});

const PROVIDER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
// dsh's own routes; a custom provider with one of these names breaks loading.
const RESERVED_PROVIDERS = new Set([DEEPSEEK.provider, "deepseek-account"]);
// Fields a provider may set. Anything else, such as literal headers, could put
// a secret into the workspace patch, which the Agent and evidence can read.
const PROVIDER_FIELDS = new Set(["api", "baseURL", "apiKeyEnv", "models", "compat", "retryPolicy", "displayName"]);
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isNonblankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function providersError(message) {
  return new RunSelectionInputError(`${DSH_PROVIDERS_ENV}: ${message}`);
}

function validateProvider(name, provider) {
  if (!PROVIDER_NAME.test(name) || RESERVED_PROVIDERS.has(name)) {
    throw providersError(`provider name '${name}' must be lowercase letters, digits, and hyphens, and not ${[...RESERVED_PROVIDERS].join(" or ")}`);
  }
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    throw providersError(`provider '${name}' must be an object`);
  }
  if (Object.hasOwn(provider, "headers")) {
    throw providersError(`provider '${name}' must not set headers; use apiKeyEnv`);
  }
  const unknown = Object.keys(provider).filter((key) => !PROVIDER_FIELDS.has(key));
  if (unknown.length > 0) {
    throw providersError(`provider '${name}' sets unsupported fields: ${unknown.join(", ")}`);
  }
  if (!Object.hasOwn(API_HEADERS, provider.api)) {
    throw providersError(`provider '${name}' api must be one of ${Object.keys(API_HEADERS).join(", ")}`);
  }
  if (
    typeof provider.apiKeyEnv !== "string"
    || !ENVIRONMENT_NAME.test(provider.apiKeyEnv)
    || ALLOWED_ENVIRONMENT_NAMES.includes(provider.apiKeyEnv)
  ) {
    throw providersError(`provider '${name}' apiKeyEnv must name an environment variable such as ONE_NEXUS_API_KEY`);
  }
  let url;
  try {
    url = new URL(provider.baseURL);
  } catch {
    throw providersError(`provider '${name}' baseURL must be an absolute URL`);
  }
  // The URL is written to the workspace, so it must carry no secret.
  if (url.username || url.password || url.search || url.hash) {
    throw providersError(`provider '${name}' baseURL must not contain credentials, a query, or a fragment`);
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw providersError(`provider '${name}' baseURL must use https, or http on a loopback address`);
  }
  // A credential route names a host with a dot; localhost has none.
  if (url.hostname === "localhost" || url.hostname === "[::1]") {
    throw providersError(`provider '${name}' baseURL must use 127.0.0.1 rather than ${url.hostname}`);
  }
  if (!url.hostname.split(".").every((label) => HOST_LABEL.test(label))) {
    throw providersError(`provider '${name}' baseURL host is not routable`);
  }
  if (
    !Array.isArray(provider.models)
    || provider.models.length === 0
    || !provider.models.every((model) => isNonblankString(model?.id))
  ) {
    throw providersError(`provider '${name}' models must list objects with an id`);
  }
}

// Read the configured providers once, when the Adapter is created.
export function readDshProviders(runtimeEnv, readFile = readFileSync) {
  const path = runtimeEnv?.[DSH_PROVIDERS_ENV];
  if (!isNonblankString(path)) return deepFreeze({});
  let parsed;
  try {
    parsed = JSON.parse(readFile(path.trim(), "utf8"));
  } catch {
    throw providersError("could not read the file as JSON");
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || Object.keys(parsed).join("\0") !== "providers"
    || !parsed.providers
    || typeof parsed.providers !== "object"
    || Array.isArray(parsed.providers)
  ) {
    throw providersError("the file must hold exactly { \"providers\": { ... } }");
  }
  for (const [name, provider] of Object.entries(parsed.providers)) {
    validateProvider(name, provider);
  }
  return deepFreeze(parsed.providers);
}

function configuredSelection(providers, name, modelId) {
  const provider = providers[name];
  const model = provider.models.find((value) => value.id === modelId);
  if (!model) {
    throw new RunSelectionInputError(`dsh provider '${name}' does not list model '${modelId}'`);
  }
  return {
    provider: name,
    model: modelId,
    apiKeyEnv: provider.apiKeyEnv,
    route: { hosts: [new URL(provider.baseURL).hostname], headerNames: API_HEADERS[provider.api] },
    reasoningEfforts: model.reasoningEfforts ?? null,
    definition: provider,
  };
}

// Pick the provider for a requested model. An id listed by exactly one
// configured provider selects it, so ids that contain a slash keep working;
// `provider/model` picks a provider explicitly; any other id without a slash,
// or no model, runs on deepseek-official.
export function resolveDshModel(providers, requestedModel) {
  const requested = requestedModel?.trim() || null;
  if (requested !== null) {
    const listing = Object.keys(providers)
      .filter((name) => providers[name].models.some((model) => model.id === requested));
    if (listing.length > 1) {
      throw new RunSelectionInputError(
        `dsh model '${requested}' is listed by several providers (${listing.join(", ")}); request it as provider/model`,
      );
    }
    if (listing.length === 1) return configuredSelection(providers, listing[0], requested);
    const slash = requested.indexOf("/");
    const prefix = slash > 0 ? requested.slice(0, slash) : null;
    const rest = slash > 0 ? requested.slice(slash + 1) : "";
    if (prefix !== null && Object.hasOwn(providers, prefix) && rest) {
      return configuredSelection(providers, prefix, rest);
    }
  }
  const deepseekPrefix = `${DEEPSEEK.provider}/`;
  const model = requested?.startsWith(deepseekPrefix)
    ? requested.slice(deepseekPrefix.length)
    : requested;
  // A mistyped provider prefix must not silently run on DeepSeek.
  if (model !== null && (!model || model.includes("/"))) {
    throw new RunSelectionInputError(
      `dsh model '${requested}' names no configured provider; check ${DSH_PROVIDERS_ENV} or the provider/model spelling`,
    );
  }
  return {
    provider: DEEPSEEK.provider,
    model: model || DEEPSEEK.defaultModel,
    apiKeyEnv: DEEPSEEK.apiKeyEnv,
    route: DEEPSEEK.route,
    reasoningEfforts: null,
    definition: null,
  };
}

function reasoningEffort(selection, effort) {
  if (!effort) return null;
  if (selection.definition === null) return REASONING_EFFORT[effort];
  const levels = selection.reasoningEfforts;
  if (levels && typeof levels === "object" && !Array.isArray(levels)) {
    if (Object.hasOwn(levels, effort)) return effort;
    if (Object.hasOwn(levels, REASONING_EFFORT[effort])) return REASONING_EFFORT[effort];
  }
  throw new RunSelectionInputError(
    `dsh model '${selection.provider}/${selection.model}' does not offer effort '${effort}'`,
  );
}

// The provider, model, and reasoning level a launch uses. Readiness calls this
// too, so a selection it passes does not fail at launch.
export function resolveDshLaunch(providers, requestedModel, effort) {
  const selection = resolveDshModel(providers, requestedModel);
  return { ...selection, reasoningEffort: reasoningEffort(selection, effort) };
}

function basicEnvironment(runtimeEnv) {
  const selected = {};
  for (const name of ALLOWED_ENVIRONMENT_NAMES) {
    if (runtimeEnv[name] !== undefined) selected[name] = runtimeEnv[name];
  }
  selected.DSH_TELEMETRY_DISABLED = "1";
  return selected;
}

function workspaceFiles(resources, selection) {
  const files = resources.skills.flatMap((skill) => skill.files.map((file) => ({
    path: `.agents/skills/${skill.name}/${file.relativePath}`,
    source: {
      kind: "selected-resource",
      handle: file.handle,
      sha256: file.sha256,
    },
  })));
  const patch = [];
  // Only the selected provider's definition reaches the workspace.
  if (selection.definition !== null) {
    patch.push({
      id: "llm-pi-ai",
      config: { providers: { [selection.provider]: selection.definition } },
    });
  }
  const config = { provider: selection.provider, model: selection.model };
  if (selection.reasoningEffort) config.reasoningEffort = selection.reasoningEffort;
  patch.push({ id: "agent-default-model", config });
  const bytes = Buffer.from(`${JSON.stringify(patch, null, 2)}\n`);
  files.push({
    path: PATCH_PATH,
    source: { kind: "generated", bytes, sha256: sha256(bytes) },
  });
  return files;
}

function normalizeDshSettings({ requestedModel, settings }) {
  if (
    requestedModel !== null
    && requestedModel !== undefined
    && (typeof requestedModel !== "string" || !requestedModel.trim())
  ) {
    throw new RunSelectionInputError(
      "requested dsh model must be a nonblank string or null",
    );
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new RunSelectionInputError("dsh Adapter settings must be an object");
  }
  if (Object.keys(settings).some(key => key !== "effort")) {
    throw new RunSelectionInputError(
      "dsh does not support Agent Adapter settings in this slice",
    );
  }
  if (settings.effort !== undefined && !isAgentEffort(settings.effort)) {
    throw new RunSelectionInputError("dsh effort must be low, medium, high, xhigh, or max");
  }
  return deepFreeze({
    requestedModel: requestedModel?.trim() || null,
    settings: settings.effort === undefined ? {} : { effort: settings.effort },
  });
}

function optionalCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function addCount(total, value) {
  const count = optionalCount(value);
  return count === null ? total : (total ?? 0) + count;
}

// Fixed, operator-safe strings: provider messages are matched, never shown.
function dshOperatorReason(frames) {
  const codes = [];
  const messages = [];
  for (const frame of frames) {
    const error = frame.type === "final" && frame.reason?.kind === "error"
      ? frame.reason.error
      : null;
    if (typeof error?.code === "string") codes.push(error.code);
    if (typeof error?.message === "string") messages.push(error.message);
    if (frame.type === "error" && typeof frame.message === "string") messages.push(frame.message);
  }
  const coded = (...names) => names.some((name) => codes.includes(name));
  const matched = (pattern) => messages.some((message) => pattern.test(message));
  if (coded("AUTH", "INVALID_CREDENTIAL", "MISSING_CREDENTIAL") || matched(/\b401\b|unauthorized|invalid api key|authentication fail/iu)) {
    return "dsh authentication failed. Set a valid key for the selected provider (DEEPSEEK_API_KEY or the provider's apiKeyEnv) in .env.local, then run `npx hurdle validate`.";
  }
  if (coded("QUOTA", "ACCOUNT_QUOTA") || matched(/\b402\b|insufficient balance/iu)) {
    return "dsh could not run because the provider account has insufficient quota or balance.";
  }
  if (coded("MODEL_UNSUPPORTED", "UNKNOWN_MODEL") || matched(/model[^.]*(does not exist|not found|is not supported)|unknown model/iu)) {
    return "dsh could not use the requested model; it may not exist or the account may lack access.";
  }
  return null;
}

// Usage sums what each step_end reports; a step whose usage dsh omits is not
// counted, so the totals are a lower bound.
function decodeDshControllerEvidence(stdout) {
  const { frames, transcript } = decodeControllerJsonl(stdout);
  const operatorReason = dshOperatorReason(frames);
  let sessionId = null;
  const usage = {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
  };
  let turns = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let finalReason = null;
  for (const frame of frames) {
    if (
      sessionId === null
      && (frame.type === "session" || frame.type === "final")
      && isNonblankString(frame.sessionId)
    ) {
      sessionId = frame.sessionId.trim();
    }
    if (frame.type === "status" && frame.phase === "turn_end") turns += 1;
    if (
      frame.type === "status"
      && frame.phase === "step_end"
      && frame.usage
      && typeof frame.usage === "object"
      && !Array.isArray(frame.usage)
    ) {
      for (const name of Object.keys(usage)) {
        usage[name] = addCount(usage[name], frame.usage[name]);
      }
    }
    if (frame.type === "tool_call") toolCalls += 1;
    if (frame.type === "tool_result" && frame.status === "error") toolErrors += 1;
    if (frame.type === "final" && isNonblankString(frame.reason?.kind)) {
      finalReason = frame.reason.kind.trim();
    }
  }
  return deepFreeze({
    transcript,
    ...(operatorReason ? { operatorReason } : {}),
    observedModel: null,
    sessionId,
    metrics: {
      common: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reportedCostUsd: null,
        turns,
        toolCalls,
      },
      adapter: {
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        reasoningTokens: usage.reasoningTokens,
        toolErrors,
        finalReason,
      },
    },
  });
}

export function createDshAdapter({
  runtimeEnv = process.env,
  command = "dsh",
  timeoutMs = 55 * 60 * 1000,
  readFile = readFileSync,
} = {}) {
  if (typeof command !== "string" || !command.trim()) {
    throw new TypeError("dsh command must be a nonblank string");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("dsh timeoutMs must be a positive safe integer");
  }
  const providers = readDshProviders(runtimeEnv, readFile);
  const environment = basicEnvironment(runtimeEnv);
  const keyNames = [DEEPSEEK.apiKeyEnv, ...Object.values(providers).map(({ apiKeyEnv }) => apiKeyEnv)];
  const secrets = [...new Set(keyNames.map((name) => runtimeEnv[name]).filter(isNonblankString))]
    .sort((left, right) => right.length - left.length);
  return Object.freeze({
    id: "dsh",
    capabilities: Object.freeze(["agent.selected-context"]),
    normalizeSettings: normalizeDshSettings,
    createLaunchPlan({
      prompt,
      requestedModel,
      settings,
      resources = { skills: [], mcpServers: [] },
    }) {
      if (typeof prompt !== "string") {
        throw new TypeError("dsh prompt must be a string");
      }
      // The headless dsh profile mounts no MCP client.
      if (resources.mcpServers.length > 0) {
        throw new RunSelectionInputError(
          "dsh does not support selected MCP servers in this slice",
        );
      }
      const normalized = normalizeDshSettings({ requestedModel, settings });
      const selection = resolveDshLaunch(providers, normalized.requestedModel, normalized.settings.effort);
      // Only the selected provider's key reaches dsh, routed to its host.
      const key = runtimeEnv[selection.apiKeyEnv];
      const env = isNonblankString(key)
        ? { ...environment, [selection.apiKeyEnv]: key }
        : environment;
      const credentialRoutes = isNonblankString(key)
        ? [{ environmentName: selection.apiKeyEnv, ...selection.route }]
        : [];
      return deepFreeze({
        command: command.trim(),
        versionProbe: true,
        args: [
          "--profile",
          "headless",
          "--patch",
          PATCH_PATH,
          "--json",
          "--permission-mode",
          "workspace-write",
          "--approval-policy",
          "never",
          "-",
        ],
        env,
        credentialRoutes,
        stdin: prompt,
        timeoutMs,
        workspaceFiles: workspaceFiles(resources, selection),
      });
    },
    redactControllerText(value) {
      return redactSecretText(value, secrets);
    },
    redactEvidenceBytes(value) {
      return redactSecretBytes(value, secrets);
    },
    decodeControllerEvidence({ stdout }) {
      return decodeDshControllerEvidence(stdout);
    },
  });
}
