export const SDK_CONTROLLER_FRAME_PREFIX = "TAE_CONTROLLER_SDK_EVENT:";
export const DEFAULT_CONTROLLER_CAPTURE_MAX_BYTES = 64 * 1024 * 1024;

export function createBoundedControllerCapture(
  maxBytes = DEFAULT_CONTROLLER_CAPTURE_MAX_BYTES,
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("controller capture maxBytes must be a positive safe integer");
  }

  const chunks = [];
  let bytes = 0;
  let droppedBytes = 0;

  return {
    append(value) {
      const chunk = String(value || "");
      const chunkBytes = Buffer.byteLength(chunk);
      if (bytes + chunkBytes > maxBytes) {
        droppedBytes += chunkBytes;
        return false;
      }
      chunks.push(chunk);
      bytes += chunkBytes;
      return true;
    },
    snapshot() {
      return {
        text: chunks.join(""),
        bytes,
        complete: droppedBytes === 0,
        droppedBytes,
        maxBytes,
      };
    },
  };
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return value && !Array.isArray(value) && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function parsedJsonlObjects(text) {
  const values = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    const value = parseJsonObject(line);
    if (!value) {
      const error = new Error("Controller-observed transcript contained a non-JSON frame");
      error.code = "CONTROLLER_TRANSCRIPT_INVALID_FRAME";
      throw error;
    }
    values.push(value);
  }
  return values;
}

function completeJsonlPrefix(text) {
  const value = String(text || "");
  const lastNewline = value.lastIndexOf("\n");
  return lastNewline >= 0 ? value.slice(0, lastNewline + 1) : "";
}

export function parseClaudeControllerMetadata(text) {
  const whole = parseJsonObject(String(text || "").trim());
  if (whole) return whole;

  let sessionId = null;
  let result = null;
  for (const value of parsedJsonlObjects(text)) {
    sessionId ||= value.session_id || value.sessionId || null;
    if (value.type === "result") result = value;
  }
  return result
    ? { ...result, session_id: result.session_id || sessionId }
    : sessionId
      ? { session_id: sessionId }
      : null;
}

function parseOptionalSdkControllerMetadata(text) {
  try {
    return parseClaudeControllerMetadata(text);
  } catch (error) {
    if (error?.code === "CONTROLLER_TRANSCRIPT_INVALID_FRAME") return null;
    throw error;
  }
}

export function decodeControllerJsonl(text) {
  const values = parsedJsonlObjects(text);
  if (values.length === 0) {
    const error = new Error("Controller emitted no controller-observed transcript frames");
    error.code = "CONTROLLER_TRANSCRIPT_EMPTY";
    throw error;
  }
  return {
    frames: values,
    transcript: `${values.map((value) => JSON.stringify(value)).join("\n")}\n`,
  };
}

export function normalizeControllerJsonl(text) {
  return decodeControllerJsonl(text).transcript;
}

export const normalizePrintControllerTranscript = normalizeControllerJsonl;

export function extractSdkControllerTranscript(stderr, token) {
  const marker = `${SDK_CONTROLLER_FRAME_PREFIX}${token}:`;
  const values = [];
  for (const line of String(stderr || "").split("\n")) {
    if (!line.startsWith(marker)) continue;
    const value = parseJsonObject(line.slice(marker.length));
    if (!value || typeof value.type !== "string") {
      const error = new Error("Claude SDK runner emitted an invalid controller frame");
      error.code = "CONTROLLER_TRANSCRIPT_INVALID_FRAME";
      throw error;
    }
    values.push(value);
  }
  if (values.length === 0) {
    const error = new Error("Claude SDK runner emitted no token-bound controller frames");
    error.code = "CONTROLLER_TRANSCRIPT_EMPTY";
    throw error;
  }
  return `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}

export function extractControllerAttempt({
  runner,
  stdout,
  stderr,
  sdkToken = null,
  final = true,
}) {
  if (runner !== "print" && runner !== "sdk") {
    throw new TypeError(`Unsupported Claude controller runner: ${runner}`);
  }

  if (runner === "sdk") {
    const transcript = extractSdkControllerTranscript(
      final ? stderr : completeJsonlPrefix(stderr),
      sdkToken,
    );
    return {
      // SDK metadata is a pretty-printed JSON document. It is not parseable
      // until the command completes, and the command transport may truncate
      // very large result payloads. Metadata is optional; the token-bound
      // message stream remains the canonical transcript and session source.
      metadata: final ? parseOptionalSdkControllerMetadata(stdout) : null,
      transcript,
    };
  }

  const controllerStdout = final ? stdout : completeJsonlPrefix(stdout);
  return {
    metadata: parseClaudeControllerMetadata(controllerStdout),
    transcript: normalizePrintControllerTranscript(controllerStdout),
  };
}

export function appendControllerTranscript(store, sessionId, segment) {
  if (!(store instanceof Map)) throw new TypeError("controller transcript store must be a Map");
  if (!sessionId) {
    const error = new Error("Controller-observed transcript has no session ID");
    error.code = "CONTROLLER_TRANSCRIPT_SESSION_ID_MISSING";
    throw error;
  }
  const content = String(segment || "");
  if (!content.trim()) {
    const error = new Error("Controller-observed transcript segment is empty");
    error.code = "CONTROLLER_TRANSCRIPT_EMPTY";
    throw error;
  }
  const previous = store.get(sessionId) || "";
  store.set(sessionId, `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}${content}`);
  return store.get(sessionId);
}

export function canRetryWithoutControllerTranscript({ promptOverflow, willRetry }) {
  return promptOverflow === true && willRetry === true;
}
