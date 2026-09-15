export function truncateUtf8(value, maxBytes) {
  const text = String(value);
  const bytes = Buffer.from(text);
  if (bytes.byteLength <= maxBytes) {
    return {
      content: text,
      originalSizeBytes: bytes.byteLength,
      includedSizeBytes: bytes.byteLength,
      truncated: false,
    };
  }
  const marker = "\n<... evidence truncated ...>\n";
  const markerBytes = Buffer.byteLength(marker);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const decodePrefix = (limit) => {
    let end = Math.min(limit, bytes.byteLength);
    while (end > 0) {
      try {
        return decoder.decode(bytes.subarray(0, end));
      } catch {
        end -= 1;
      }
    }
    return "";
  };
  const decodeSuffix = (limit) => {
    let start = Math.max(0, bytes.byteLength - limit);
    while (start < bytes.byteLength) {
      try {
        return decoder.decode(bytes.subarray(start));
      } catch {
        start += 1;
      }
    }
    return "";
  };
  if (maxBytes <= markerBytes) {
    const content = decodePrefix(maxBytes);
    return {
      content,
      originalSizeBytes: bytes.byteLength,
      includedSizeBytes: Buffer.byteLength(content),
      truncated: true,
    };
  }
  const contentBudget = Math.max(0, maxBytes - markerBytes);
  const headBytes = Math.ceil(contentBudget / 2);
  const tailBytes = Math.floor(contentBudget / 2);
  const content = `${decodePrefix(headBytes)}${marker}${decodeSuffix(tailBytes)}`;
  return {
    content,
    originalSizeBytes: bytes.byteLength,
    includedSizeBytes: Buffer.byteLength(content),
    truncated: true,
  };
}

// Only payload strings may be shortened. Structural fields (IDs, tool names,
// roles, flags and timestamps), frames and ordering are never removed/rewritten.
const PAYLOAD_FIELDS = new Set([
  "content", "text", "message", "result", "output", "input", "arguments",
  "command", "stdout", "stderr", "description", "summary", "prompt", "body",
]);
const SMALL_PAYLOAD_BYTES = 2048;

function compactPayloads(value, cap, key = "", depth = 0) {
  if (depth > 64) throw new RangeError("Transcript nesting exceeds the safe limit");
  if (typeof value === "number" && (
    !Number.isFinite(value)
    || (Number.isInteger(value) && !Number.isSafeInteger(value))
    || Object.is(value, -0)
  )) {
    throw new RangeError("Transcript number cannot be safely reserialized");
  }
  if (typeof value === "string") {
    return PAYLOAD_FIELDS.has(key) && Buffer.byteLength(value) > SMALL_PAYLOAD_BYTES
      ? truncateUtf8(value, cap).content
      : value;
  }
  if (Array.isArray(value)) {
    return value.map(item => compactPayloads(item, cap, key, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [
      name, compactPayloads(item, cap, name, depth + 1),
    ]));
  }
  return value;
}

/**
 * Projection v2: pack whole JSONL frames into bounded chronological chunks.
 * Input MUST already be redacted. Preserve bytes where possible; compact only
 * oversized frames, keeping short payloads, IDs and structure. Reject the whole
 * projection if all frames cannot fit; never select/drop execution evidence.
 */
export function projectJudgeTranscript(value, { maxItemBytes, maxTextBytes, maxItems }) {
  const text = String(value);
  const originalSizeBytes = Buffer.byteLength(text);
  if (maxItems < 1 || maxTextBytes < 1) return null;
  if (originalSizeBytes <= Math.min(maxItemBytes, maxTextBytes)) {
    return [truncateUtf8(text, maxItemBytes)];
  }
  if (originalSizeBytes > 16 * 1024 * 1024) return null;
  try {
    const lines = text.match(/[^\n]*(?:\n|$)/g).filter(Boolean);
    if (lines.length > 4096) return null;
    const chunks = [];
    let total = 0;
    for (const line of lines) {
      const frame = line.trim() ? JSON.parse(line) : null;
      if (line.trim() && (!frame || typeof frame !== "object" || Array.isArray(frame))) return null;
      let projected = truncateUtf8(line, Buffer.byteLength(line));
      if (projected.includedSizeBytes > maxItemBytes) {
        if (frame === null) return null;
        // Finite passes bound work. Short execution payloads are not sacrificed
        // to fit verbose docs, even when the containing frame needs compaction.
        for (const cap of [8192, 4096, 2048, 1024, 512, 256, 128]) {
          const content = JSON.stringify(compactPayloads(frame, cap)) + (line.endsWith("\n") ? "\n" : "");
          projected = {
            content,
            originalSizeBytes: Buffer.byteLength(line),
            includedSizeBytes: Buffer.byteLength(content),
            truncated: true,
          };
          if (projected.includedSizeBytes <= maxItemBytes) break;
        }
      }
      if (projected.includedSizeBytes > maxItemBytes) return null;
      total += projected.includedSizeBytes;
      if (total > maxTextBytes) return null;
      const previous = chunks.at(-1);
      if (previous && previous.includedSizeBytes + projected.includedSizeBytes <= maxItemBytes) {
        previous.content += projected.content;
        previous.includedSizeBytes += projected.includedSizeBytes;
        previous.originalSizeBytes += projected.originalSizeBytes;
        previous.truncated ||= projected.truncated;
      } else {
        chunks.push(projected);
        if (chunks.length > maxItems) return null;
      }
    }
    return chunks;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) return null;
    throw error;
  }
}
