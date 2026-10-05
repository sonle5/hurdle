
import { createHash } from "node:crypto";

function checkId(value, label) {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new TypeError(label + " id must use lowercase kebab-case");
  }
  return value;
}

function sha256String(value) {
  return "sha256:" + createHash("sha256").update(value, "utf8").digest("hex");
}

function rubricDefinition(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("run.judge requires a nonblank rubric");
  }
  if (value.length > 32_768) {
    throw new TypeError("run.judge rubric exceeds 32768 characters");
  }
  return value;
}

function toolDefinition(name, value) {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) {
    throw new TypeError("run.expect.tool name must be a bounded identifier");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("run.expect.tool requires an options object");
  }
  if (Object.keys(value).some((key) => !["count", "required"].includes(key))) {
    throw new TypeError("run.expect.tool contains an unknown field");
  }
  if (!Number.isSafeInteger(value.count) || value.count < 1 || value.count > 16) {
    throw new TypeError("run.expect.tool count must be between 1 and 16");
  }
  if (value.required !== undefined && typeof value.required !== "boolean") {
    throw new TypeError("run.expect.tool required must be boolean");
  }
  return {
    id: "tool-" + name.replaceAll("_", "-").toLowerCase(),
    name,
    count: value.count,
    nameHash: sha256String(name),
    required: value.required ?? true,
  };
}

function requestDefinition(value, label = "run.expect.request") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} requires an object`);
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !["id", "method", "path", "status", "required"].includes(key))) {
    throw new TypeError(`${label} contains an unknown field`);
  }
  if (typeof value.method !== "string" || !/^[A-Z]+$/.test(value.method)) {
    throw new TypeError(`${label} method must be uppercase`);
  }
  if (typeof value.path !== "string" || !value.path.startsWith("/") || value.path.includes("?")) {
    throw new TypeError(`${label} path must be an exact query-free path`);
  }
  if (!Number.isInteger(value.status) || value.status < 100 || value.status > 599) {
    throw new TypeError(`${label} status must be an HTTP status`);
  }
  if (value.required !== undefined && typeof value.required !== "boolean") {
    throw new TypeError(`${label} required must be boolean`);
  }
  return {
    id: checkId(value.id, "request"),
    method: value.method,
    path: value.path,
    status: value.status,
    required: value.required ?? true,
  };
}

function blockedRequestDefinition(value) {
  const label = "guard.block.request";
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} requires an object`);
  }
  if (Object.keys(value).some((key) => !["id", "method", "path"].includes(key))) {
    throw new TypeError(`${label} contains an unknown field`);
  }
  if (typeof value.method !== "string" || !/^[A-Z]{1,16}$/.test(value.method)) {
    throw new TypeError(`${label} method must be uppercase and at most 16 characters`);
  }
  if (
    typeof value.path !== "string"
    || !value.path.startsWith("/")
    || value.path.includes("?")
    || value.path.includes("#")
    || Buffer.byteLength(value.path) > 4_096
  ) {
    throw new TypeError(`${label} path must be an exact query-free path`);
  }
  return {
    id: checkId(value.id, "blocked request"),
    method: value.method,
    path: value.path,
  };
}

function artifactDefinition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("run.expect.artifact requires an object");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !["id", "path", "format", "maxBytes", "required"].includes(key))) {
    throw new TypeError("run.expect.artifact contains an unknown field");
  }
  if (
    typeof value.path !== "string"
    || !/^[A-Za-z0-9._/-]+$/.test(value.path)
    || value.path.startsWith("/")
    || value.path.split("/").includes("..")
  ) {
    throw new TypeError("run.expect.artifact path must be a safe relative path");
  }
  if (!["json", "text"].includes(value.format)) {
    throw new TypeError("run.expect.artifact format must be json or text");
  }
  if (!Number.isSafeInteger(value.maxBytes) || value.maxBytes < 1 || value.maxBytes > 1048576) {
    throw new TypeError("run.expect.artifact maxBytes must be between 1 and 1048576");
  }
  if (value.required !== undefined && typeof value.required !== "boolean") {
    throw new TypeError("run.expect.artifact required must be boolean");
  }
  return {
    id: checkId(value.id, "artifact"),
    path: value.path,
    format: value.format,
    maxBytes: value.maxBytes,
    required: value.required ?? true,
  };
}

export function collectDeclarations(callback) {
  const requests = [];
  const artifacts = [];
  const tools = [];
  const checkIds = [];
  let completion = false;
  let replyIncludes = false;
  let deterministicCheckCount = 0;
  let rubric = null;
  const run = Object.freeze({
    agentReply: null,
    evidence: Object.freeze({ transcript: null, requests: null, artifact() { return null; } }),
    artifacts: Object.freeze({ json() { return null; }, text() { return null; } }),
    check(value) {
      checkIds.push(checkId(value?.id, "run.check"));
      deterministicCheckCount += 1;
    },
    judge(value) {
      if (rubric !== null) throw new TypeError("run.judge may be declared only once");
      rubric = rubricDefinition(value);
    },
    expect: Object.freeze({
      completed() {
        if (completion) throw new TypeError("run.expect.completed may be declared only once");
        completion = true;
        checkIds.push("completed");
        deterministicCheckCount += 1;
      },
      replyIncludes() {
        if (replyIncludes) throw new TypeError("run.expect.replyIncludes may be declared only once");
        replyIncludes = true;
        checkIds.push("reply-includes");
        deterministicCheckCount += 1;
      },
      request(value) {
        const definition = requestDefinition(value);
        requests.push(definition);
        checkIds.push(definition.id);
        deterministicCheckCount += 1;
      },
      artifact(value) {
        const definition = artifactDefinition(value);
        artifacts.push(definition);
        checkIds.push(definition.id);
        deterministicCheckCount += 1;
      },
      tool(name, value) {
        const definition = toolDefinition(name, value);
        tools.push(definition);
        checkIds.push(definition.id);
        deterministicCheckCount += 1;
      },
    }),
    observe: Object.freeze({
      request(value) {
        if (value && Object.hasOwn(value, "required")) {
          throw new TypeError("run.observe.request does not accept required");
        }
        const definition = requestDefinition(
          { ...value, required: false },
          "run.observe.request",
        );
        requests.push(definition);
        checkIds.push(definition.id);
        deterministicCheckCount += 1;
      },
    }),
  });
  callback(run);
  if (new Set(checkIds).size !== checkIds.length) throw new TypeError("check ids must be unique");
  if (new Set(artifacts.map(({ path }) => path)).size !== artifacts.length) {
    throw new TypeError("artifact paths must be unique");
  }
  if (tools.length > 0) {
    const chatRequests = requests.filter(({ path }) => /\/chat\/completions$/.test(path));
    if (chatRequests.length !== 1) {
      throw new TypeError("run.expect.tool requires exactly one chat-completions request expectation");
    }
    for (const tool of tools) tool.request = chatRequests[0];
  }
  return {
    requests,
    artifacts,
    tools,
    checkIds,
    rubric,
    hasDeterministicChecks: deterministicCheckCount > 0,
  };
}

export function collectGuardDeclarations(callback) {
  if (typeof callback !== "function") {
    throw new TypeError("defineGuard must export a function");
  }
  const blockedRequests = [];
  const guard = Object.freeze({
    block: Object.freeze({
      request(value) {
        blockedRequests.push(blockedRequestDefinition(value));
      },
    }),
  });
  callback(guard);
  if (blockedRequests.length === 0) {
    throw new TypeError("defineGuard must declare at least one guard");
  }
  if (new Set(blockedRequests.map(({ id }) => id)).size !== blockedRequests.length) {
    throw new TypeError("guard ids must be unique");
  }
  if (
    new Set(blockedRequests.map(({ method, path }) => `${method}\n${path}`)).size
    !== blockedRequests.length
  ) {
    throw new TypeError("blocked request method and path pairs must be unique");
  }
  return { blockedRequests };
}

export function collectTaskDeclarations(checksCallback, guardCallback = null) {
  const declarations = collectDeclarations(checksCallback);
  const blockedRequests = guardCallback === null
    ? []
    : collectGuardDeclarations(guardCallback).blockedRequests;
  const ids = [
    ...declarations.checkIds,
    ...blockedRequests.map(({ id }) => id),
  ];
  if (new Set(ids).size !== ids.length) {
    throw new TypeError("check and guard ids must be unique");
  }
  if (blockedRequests.some((blocked) => declarations.requests.some((request) => (
    request.method === blocked.method && request.path === blocked.path
  )))) {
    throw new TypeError("a request cannot be both expected and blocked");
  }
  return {
    ...declarations,
    blockedRequests,
    hasDeterministicChecks: declarations.hasDeterministicChecks || blockedRequests.length > 0,
  };
}

function factMatches(facts, id) {
  const result = facts?.[id];
  return result?.state === "present" && Array.isArray(result.matches) ? result.matches : [];
}

function indexedFacts(matches, pattern) {
  const values = new Map();
  for (const match of matches) {
    const parsed = pattern.exec(match.pointer);
    if (parsed && typeof match.value === "string") {
      values.set(parsed.slice(1).join(":"), match.value);
    }
  }
  return values;
}

function correlatedTools(collections, expected) {
  const events = collections.flatMap((collection) => collection.requests ?? [])
    .filter((request) => (
      request.method === expected.request.method
      && request.path === expected.request.path
      && request.statusCode === expected.request.status
      && request.exchangeFacts?.profileId === "v1-native-tool-calls"
    ))
    .sort((left, right) => left.sequence - right.sequence);
  const correlated = [];
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const response = events[eventIndex].exchangeFacts.response;
    const ids = indexedFacts(
      factMatches(response, "response-tool-call-id-hashes"),
      /^\/choices\/(\d+)\/message\/tool_calls\/(\d+)\/id$/,
    );
    const names = indexedFacts(
      factMatches(response, "response-tool-call-name-hashes"),
      /^\/choices\/(\d+)\/message\/tool_calls\/(\d+)\/function\/name$/,
    );
    const inputs = indexedFacts(
      factMatches(response, "response-tool-call-argument-hashes"),
      /^\/choices\/(\d+)\/message\/tool_calls\/(\d+)\/function\/arguments$/,
    );
    for (const [key, idHash] of ids) {
      const inputHash = inputs.get(key);
      if (names.get(key) !== expected.nameHash || typeof inputHash !== "string") continue;
      const continuation = events.slice(eventIndex + 1).find((event) => {
        const request = event.exchangeFacts.request;
        const assistantIds = indexedFacts(
          factMatches(request, "request-assistant-call-id-hashes"),
          /^\/messages\/(\d+)\/tool_calls\/(\d+)\/id$/,
        );
        const assistantInputs = indexedFacts(
          factMatches(request, "request-assistant-call-argument-hashes"),
          /^\/messages\/(\d+)\/tool_calls\/(\d+)\/function\/arguments$/,
        );
        const resultIds = new Set(factMatches(request, "request-tool-result-call-id-hashes").map(({ value }) => value));
        return [...assistantIds].some(([assistantKey, assistantId]) => (
          assistantId === idHash && assistantInputs.get(assistantKey) === inputHash
        )) && resultIds.has(idHash);
      });
      if (continuation) correlated.push([events[eventIndex].evidenceRef, continuation.evidenceRef]);
    }
  }
  return correlated;
}

function agentReply(transcript) {
  if (!transcript || typeof transcript.jsonl !== "string") return null;
  let reply = null;
  for (const line of transcript.jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const frame = JSON.parse(line);
      if (frame?.type === "result" && typeof frame.result === "string") {
        reply = frame.result.trimEnd();
      }
    } catch {}
  }
  return reply;
}

function agentCompleted(transcript) {
  if (!transcript || typeof transcript.jsonl !== "string") return null;
  let terminal = null;
  for (const line of transcript.jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const frame = JSON.parse(line);
      if (frame?.type === "result") {
        terminal = frame.subtype === "success" && frame.is_error !== true;
      } else if (frame?.type === "turn.completed") {
        terminal = true;
      } else if (frame?.type === "turn.failed") {
        terminal = false;
      }
    } catch {}
  }
  return terminal ?? false;
}

export function evaluateChecks(callback, input, guardCallback = null) {
  const checks = [];
  const declaredRequests = [];
  const transcriptEvidence = input.transcript?.evidenceRef ?? null;
  const reply = agentReply(input.transcript);
  const completed = agentCompleted(input.transcript);
  const relevantHosts = new Set(input.snapshot.target.egress?.relevantHosts ?? []);
  const trustedCollections = (input.egress ?? []).filter((collection) => (
    collection.status === "captured"
    && collection.provenance?.lifecyclePhase === "execution"
    && ["controller-observed", "environment-observed"].includes(collection.provenance?.trust)
  ));
  const requestEvidence = trustedCollections.length === 0 ? null : Object.freeze(
    trustedCollections.flatMap((collection) => collection.requests ?? [])
      .filter((request) => relevantHosts.has(request.host))
      .map((request) => Object.freeze({
        method: request.method,
        host: request.host,
        path: request.path,
        status: request.statusCode,
        disposition: request.disposition ?? "forwarded",
        evidence: request.evidenceRef ?? null,
      })),
  );
  const artifactReads = new Map();
  const readArtifact = (path) => {
    if (!artifactReads.has(path)) artifactReads.set(path, input.readArtifactText(path));
    return artifactReads.get(path);
  };
  const recordCheck = (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("run.check requires an object");
      }
      const { id, passed, summary, required = true, evidence = [] } = value;
      if (typeof id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
        throw new TypeError("run.check id must use lowercase kebab-case");
      }
      if (checks.some((check) => check.id === id)) throw new TypeError("duplicate run.check id");
      if (![true, false, null].includes(passed)) {
        throw new TypeError("run.check passed must be true, false, or null");
      }
      if (typeof summary !== "string" || !summary.trim()) {
        throw new TypeError("run.check summary must be nonblank");
      }
      if (summary.length > 4_096) throw new TypeError("run.check summary exceeds 4096 characters");
      if (typeof required !== "boolean" || !Array.isArray(evidence)) {
        throw new TypeError("run.check fields are invalid");
      }
      checks.push({
        id,
        required,
        outcome: passed === null ? "skip" : passed ? "pass" : "fail",
        summary: summary.trim(),
        evidenceRefs: [...new Set(evidence.filter((item) => typeof item === "string"))],
      });
  };
  const recordRequest = (expected) => {
    declaredRequests.push(expected);
    const available = trustedCollections.length > 0;
    const matches = trustedCollections.flatMap((collection) => collection.requests ?? [])
      .filter((request) => (
        relevantHosts.has(request.host)
        && request.method === expected.method
        && request.path === expected.path
        && request.statusCode === expected.status
      ));
    recordCheck({
      id: expected.id,
      required: expected.required,
      passed: available ? matches.length > 0 : null,
      summary: !available
        ? "Trusted HTTP evidence was unavailable."
        : matches.length > 0
          ? "Observed the expected successful HTTP request."
          : "The expected successful HTTP request was not observed.",
      evidence: matches.map(({ evidenceRef }) => evidenceRef),
    });
  };
  const recordBlockedRequest = (expected) => {
    const available = trustedCollections.length > 0;
    const matches = trustedCollections.flatMap((collection) => collection.requests ?? [])
      .filter((request) => (
        relevantHosts.has(request.host)
        && request.method === expected.method
        && request.path === expected.path
        && request.disposition === "blocked"
      ));
    recordCheck({
      id: expected.id,
      required: true,
      passed: available ? matches.length === 0 : null,
      summary: !available
        ? "Trusted request-blocking evidence was unavailable."
        : matches.length === 0
          ? "No blocked request was attempted."
          : `Blocked ${matches.length} matching request${matches.length === 1 ? "" : "s"} before reaching the target API.`,
      evidence: matches.map(({ evidenceRef }) => evidenceRef),
    });
  };
  const run = Object.freeze({
    agentReply: reply,
    evidence: Object.freeze({
      transcript: transcriptEvidence,
      requests: requestEvidence,
      artifact(path) { return readArtifact(path)?.evidenceRef ?? null; },
    }),
    artifacts: Object.freeze({
      text(path) {
        const artifact = readArtifact(path);
        return artifact.status === "present" ? artifact.text : null;
      },
      json(path) {
        const artifact = readArtifact(path);
        if (artifact.status !== "present") return null;
        try { return JSON.parse(artifact.text); } catch { return null; }
      },
    }),
    check: recordCheck,
    judge(value) { rubricDefinition(value); },
    expect: Object.freeze({
      completed() {
        recordCheck({
          id: "completed",
          passed: completed,
          summary: completed === null
            ? "The Agent transcript was unavailable."
            : completed
              ? "The Agent completed successfully."
              : "The Agent did not record a successful completion.",
          evidence: [transcriptEvidence],
        });
      },
      replyIncludes(expected) {
        if (typeof expected !== "string" || !expected) {
          throw new TypeError("run.expect.replyIncludes requires nonempty text");
        }
        recordCheck({
          id: "reply-includes",
          passed: reply === null ? null : reply.includes(expected),
          summary: reply === null
            ? "The Agent reply was unavailable."
            : "The Agent reply "
              + (reply.includes(expected) ? "includes" : "does not include")
              + " the expected text.",
          evidence: [transcriptEvidence],
        });
      },
      request(value) {
        recordRequest(requestDefinition(value));
      },
      artifact(value) {
        const expected = artifactDefinition(value);
        const artifact = readArtifact(expected.path);
        let passed = null;
        if (artifact.status === "present") {
          if (expected.format === "text") passed = true;
          else {
            try { JSON.parse(artifact.text); passed = true; } catch { passed = false; }
          }
        }
        recordCheck({
          id: expected.id,
          required: expected.required,
          passed,
          summary: passed === null
            ? "The captured artifact was unavailable."
            : passed
              ? "The expected artifact was captured."
              : "The captured artifact was not valid JSON.",
          evidence: [artifact.evidenceRef],
        });
      },
      tool(name, value) {
        const expected = toolDefinition(name, value);
        const chatRequests = declaredRequests.filter(({ path }) => /\/chat\/completions$/.test(path));
        if (chatRequests.length !== 1) {
          throw new TypeError("run.expect.tool requires exactly one preceding chat-completions request expectation");
        }
        expected.request = chatRequests[0];
        const collections = trustedCollections;
        const matches = correlatedTools(collections, expected);
        recordCheck({
          id: expected.id,
          required: expected.required,
          passed: collections.length === 0 ? null : matches.length === expected.count,
          summary: collections.length === 0
            ? "Trusted native-tool evidence was unavailable."
            : matches.length === expected.count
              ? "Observed the expected provider-native tool call and correlated result."
              : "The expected provider-native tool call correlation was not observed.",
          evidence: matches.flat(),
        });
      },
    }),
    observe: Object.freeze({
      request(value) {
        if (value && Object.hasOwn(value, "required")) {
          throw new TypeError("run.observe.request does not accept required");
        }
        recordRequest(requestDefinition(
          { ...value, required: false },
          "run.observe.request",
        ));
      },
    }),
  });
  callback(run);
  if (guardCallback !== null) {
    for (const blockedRequest of collectGuardDeclarations(guardCallback).blockedRequests) {
      recordBlockedRequest(blockedRequest);
    }
  }
  if (checks.length === 0) throw new TypeError("defineChecks must record at least one check");
  return { checks, targetMetrics: {} };
}
