import { pathToFileURL } from "node:url";

const sendResult = process.send?.bind(process);
const terminate = process.exit.bind(process);
process.send = undefined;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function jsonSafe(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  const valid = children.every((child) => jsonSafe(child, seen));
  seen.delete(value);
  return valid;
}

function artifactMap(artifacts) {
  return new Map(artifacts.map((artifact) => [artifact.path, {
    ...artifact,
    bytes: artifact.bytesBase64 !== null
      ? Buffer.from(artifact.bytesBase64, "base64")
      : null,
  }]));
}

function requireDeclaredArtifact(artifactsByPath, path, kind = null) {
  const artifact = artifactsByPath.get(path);
  if (!artifact) {
    throw new TypeError(`Deterministic Evaluator requested undeclared artifact '${path}'`);
  }
  if (kind && artifact.kind !== kind) {
    throw new TypeError(
      `Deterministic Evaluator requested ${kind} access to '${path}', declared as ${artifact.kind}`,
    );
  }
  return artifact;
}

const assertions = Object.freeze({
  createCheck({
    id,
    valid,
    passSummary,
    failSummary,
    evidenceRefs = [],
    required = true,
  }) {
    return {
      id,
      required,
      outcome: valid ? "pass" : "fail",
      summary: valid ? passSummary : failSummary,
      evidenceRefs: [...new Set(evidenceRefs.filter(Boolean))],
    };
  },
  detectImageFormat(bytes) {
    if (!(bytes instanceof Uint8Array)) return null;
    if (assertions.matchesBytes(
      bytes,
      0,
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    )) return "png";
    if (assertions.matchesBytes(bytes, 0, [0xff, 0xd8, 0xff])) return "jpeg";
    if (
      assertions.matchesBytes(bytes, 0, "RIFF")
      && assertions.matchesBytes(bytes, 8, "WEBP")
    ) return "webp";
    return null;
  },
  hasExactObjectKeys(value, required, optional = []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const allowed = new Set([...required, ...optional]);
    const keys = Object.keys(value);
    return required.every((key) => Object.hasOwn(value, key))
      && keys.every((key) => allowed.has(key));
  },
  isSuccessfulHttpStatus(statusCode) {
    return statusCode === 101
      || (Number.isInteger(statusCode) && statusCode >= 200 && statusCode <= 399);
  },
  matchesBytes(bytes, offset, expected) {
    if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(offset) || offset < 0) {
      return false;
    }
    const sequence = typeof expected === "string"
      ? new TextEncoder().encode(expected)
      : Uint8Array.from(expected);
    if (offset + sequence.byteLength > bytes.byteLength) return false;
    return sequence.every((byte, index) => bytes[offset + index] === byte);
  },
  parseJsonArtifact(result) {
    if (result?.status !== "present") return null;
    try {
      return JSON.parse(result.text);
    } catch {
      return null;
    }
  },
});

function evidenceView({ snapshot, transcript, execution, artifacts, egress = [], lifecycle = {} }) {
  const artifactsByPath = artifactMap(artifacts);
  return Object.freeze({
    snapshot: deepFreeze(snapshot),
    transcript: deepFreeze(transcript),
    execution: deepFreeze(execution),
    egress: deepFreeze(egress),
    lifecycle: deepFreeze(lifecycle),
    assertions,
    readArtifactText(path) {
      const artifact = requireDeclaredArtifact(artifactsByPath, path, "text");
      if (artifact.status !== "captured") return Object.freeze({ status: "missing" });
      try {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        return Object.freeze({
          status: "present",
          text: decoder.decode(artifact.bytes),
          sha256: artifact.sha256,
          evidenceRef: artifact.evidenceRef,
        });
      } catch {
        return Object.freeze({
          status: "invalid_utf8",
          sha256: artifact.sha256,
        });
      }
    },
    readArtifactBytes(path) {
      const artifact = requireDeclaredArtifact(artifactsByPath, path);
      if (artifact.status !== "captured") return Object.freeze({ status: "missing" });
      return Object.freeze({
        status: "present",
        bytes: new Uint8Array(artifact.bytes),
        sha256: artifact.sha256,
        evidenceRef: artifact.evidenceRef,
      });
    },
  });
}

function reply(message) {
  if (!sendResult) return;
  sendResult(message, () => terminate(0));
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input) > 128 * 1024 * 1024) process.exit(1);
});
process.stdin.on("end", async () => {
  try {
    const payload = JSON.parse(input);
    const evaluatorModule = await import(pathToFileURL(process.argv[2]).href);
    if (typeof evaluatorModule.evaluate !== "function") throw new TypeError("invalid evaluator");
    const evaluation = await evaluatorModule.evaluate(evidenceView(payload));
    if (!jsonSafe(evaluation)) throw new TypeError("invalid evaluator output");
    const encoded = JSON.stringify(evaluation);
    if (Buffer.byteLength(encoded) > 1024 * 1024) {
      throw new TypeError("evaluator output exceeds limit");
    }
    reply({ ok: true, evaluation });
  } catch {
    reply({ ok: false });
  }
});
