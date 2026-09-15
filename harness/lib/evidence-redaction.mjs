import { isUtf8 } from "node:buffer";

const REDACTED = "<REDACTED>";
const MAX_RECURSION_DEPTH = 32;
const MIN_SECRET_PREFIX_LENGTH = 8;

// Scrub known credentials and common diagnostic prints such as key.slice(0, 20).
// Match the longest printed prefix in one pass; replacing only the first eight
// characters would leave the rest behind. Do not enumerate all prefixes (OAuth
// tokens can be large), guess arbitrary substrings, or decode binary artifacts.
function secretPatterns(secrets) {
  return [...new Set(secrets.filter((secret) => (
    typeof secret === "string" && secret.length > 0
  )))].flatMap((secret) => {
    const prefix = [...secret].slice(0, MIN_SECRET_PREFIX_LENGTH).join("");
    return [
      {
        secret: Buffer.from(secret),
        prefix: Buffer.from(prefix),
        textSecret: secret,
        textPrefix: prefix,
      },
      {
        secret: Buffer.from(JSON.stringify(secret).slice(1, -1)),
        prefix: Buffer.from(JSON.stringify(prefix).slice(1, -1)),
      },
    ];
  });
}

function replaceSecretBytes(bytes, patterns) {
  const chunks = [];
  const candidates = patterns.map((pattern) => ({
    ...pattern, index: bytes.indexOf(pattern.prefix),
  }));
  let cursor = 0;
  while (cursor < bytes.length) {
    let start = bytes.length;
    let length = 0;
    for (const pattern of candidates) {
      const { index } = pattern;
      if (index === -1 || index > start) continue;
      let matched = pattern.prefix.length;
      while (matched < pattern.secret.length && bytes[index + matched] === pattern.secret[matched]) {
        matched += 1;
      }
      // Do not split a UTF-8 character when otherwise matching plain text.
      while (matched > pattern.prefix.length && (pattern.secret[matched] & 0xc0) === 0x80) {
        matched -= 1;
      }
      length = index < start ? matched : Math.max(length, matched);
      start = index;
    }
    if (length === 0) break;
    chunks.push(bytes.subarray(cursor, start), Buffer.from(REDACTED));
    cursor = start + length;
    for (const pattern of candidates) {
      if (pattern.index !== -1 && pattern.index < cursor) {
        pattern.index = bytes.indexOf(pattern.prefix, cursor);
      }
    }
  }
  return chunks.length === 0 ? bytes : Buffer.concat([...chunks, bytes.subarray(cursor)]);
}

function decodeJsonUnicodeEscapes(text) {
  const decodedUnits = [];
  const originalStarts = [];
  const originalEnds = [];
  for (let index = 0; index < text.length;) {
    const escape = text[index] === "\\" && text[index + 1] === "u"
      ? text.slice(index + 2, index + 6)
      : "";
    const escaped = escape.length === 4 && /^[0-9a-fA-F]{4}$/.test(escape);
    const end = index + (escaped ? 6 : 1);
    decodedUnits.push(escaped ? String.fromCharCode(Number.parseInt(escape, 16)) : text[index]);
    originalStarts.push(index);
    originalEnds.push(end);
    index = end;
  }
  return {
    decoded: decodedUnits.join(""), originalEnds, originalStarts,
  };
}

// A diagnostic line need not be valid JSON, but an Agent can still print a
// credential using JSON Unicode escapes. Compare against a decoded view while
// slicing replacements from the original text so unrelated bytes and escapes
// retain their exact spelling.
function replaceUnicodeEscapedSecrets(text, patterns) {
  if (!/\\u[0-9a-fA-F]{4}/.test(text)) return text;
  const textPatterns = patterns.filter(({ textSecret }) => textSecret !== undefined);
  const {
    decoded, originalEnds, originalStarts,
  } = decodeJsonUnicodeEscapes(text);
  const chunks = [];
  let decodedCursor = 0;
  let originalCursor = 0;

  while (decodedCursor < decoded.length) {
    let next = null;
    for (const pattern of textPatterns) {
      const start = decoded.indexOf(pattern.textPrefix, decodedCursor);
      if (start === -1) continue;
      let matched = pattern.textPrefix.length;
      while (
        matched < pattern.textSecret.length
        && decoded[start + matched] === pattern.textSecret[matched]
      ) {
        matched += 1;
      }
      // Do not split a surrogate pair when only a credential prefix was printed.
      if (
        matched > pattern.textPrefix.length
        && matched < pattern.textSecret.length
        && /[\uDC00-\uDFFF]/.test(pattern.textSecret[matched])
        && /[\uD800-\uDBFF]/.test(pattern.textSecret[matched - 1])
      ) {
        matched -= 1;
      }
      const end = start + matched;
      if (next === null || start < next.start || (start === next.start && end > next.end)) {
        next = { end, start };
      }
    }
    if (next === null) break;
    chunks.push(text.slice(originalCursor, originalStarts[next.start]), REDACTED);
    originalCursor = originalEnds[next.end - 1];
    decodedCursor = next.end;
  }

  return chunks.length === 0 ? text : chunks.join("") + text.slice(originalCursor);
}

function redactSecretString(text, patterns, depth = 0) {
  if (patterns.length === 0) return text;
  if (depth > MAX_RECURSION_DEPTH) return REDACTED;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // JSONL is the controller format. Redact individual JSON string tokens so a
    // quoted credential prefix cannot eat a frame delimiter or half an escape.
    const lines = text.split("\n");
    if (lines.length > 1 && lines.every((line) => {
      if (!line.trim()) return true;
      try { JSON.parse(line); return true; } catch { return false; }
    })) {
      return lines.map((line) => redactSecretString(line, patterns, depth + 1)).join("\n");
    }
  }
  if (parsed !== undefined) {
    let result = "";
    let cursor = 0;
    for (let index = 0; index < text.length; index += 1) {
      const quoted = text[index] === '"';
      if (!quoted && !/[0-9tfn-]/.test(text[index])) continue;
      let end = quoted ? parseQuotedStringEnd(text, index) : index + 1;
      if (!quoted) {
        while (end < text.length && !/[\s,}\]]/.test(text[end])) end += 1;
      }
      const original = quoted ? JSON.parse(text.slice(index, end)) : text.slice(index, end);
      const redacted = quoted
        ? redactSecretString(original, patterns, depth + 1)
        : replaceSecretBytes(Buffer.from(original), patterns).toString("utf8");
      result += text.slice(cursor, index) + (original === redacted
        ? text.slice(index, end)
        : JSON.stringify(redacted));
      cursor = end;
      index = end - 1;
    }
    return result + text.slice(cursor);
  }
  const unicodeRedacted = replaceUnicodeEscapedSecrets(text, patterns);
  return replaceSecretBytes(Buffer.from(unicodeRedacted), patterns).toString("utf8");
}

export function redactSecretText(value, secrets) {
  return redactSecretString(String(value), secretPatterns(secrets));
}

export function redactSecretBytes(value, secrets) {
  const bytes = Buffer.from(value);
  const patterns = secretPatterns(secrets);
  return isUtf8(bytes)
    ? Buffer.from(redactSecretString(bytes.toString("utf8"), patterns))
    : replaceSecretBytes(bytes, patterns);
}

function redactParsedValue(value, fields, depth) {
  if (depth > MAX_RECURSION_DEPTH) return REDACTED;
  if (Array.isArray(value)) {
    return value.map((item) => redactParsedValue(item, fields, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      fields.has(key) ? REDACTED : redactParsedValue(item, fields, depth + 1),
    ]));
  }
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed && ["{", "[", '"'].includes(trimmed[0])) {
    try {
      return JSON.stringify(redactParsedValue(JSON.parse(value), fields, depth + 1));
    } catch {
      // Fall through to the bounded structured-field scrubber. Agent tool output
      // commonly prefixes JSON or renders the same fields as Python repr/YAML.
    }
  }
  return redactEmbeddedStructuredFields(value, fields);
}

function parseQuotedStringEnd(text, start) {
  const quote = text[start];
  if (quote !== '"' && quote !== "'") return null;
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === quote) return index + 1;
  }
  return null;
}

function parseStructuredValueEnd(text, start) {
  if (text[start] === '"' || text[start] === "'") return parseQuotedStringEnd(text, start);
  if (text[start] === "{" || text[start] === "[") {
    const stack = [text[start] === "{" ? "}" : "]"];
    for (let index = start + 1; index < text.length; index += 1) {
      if (text[index] === '"' || text[index] === "'") {
        const end = parseQuotedStringEnd(text, index);
        if (end === null) return null;
        index = end - 1;
      } else if (text[index] === "{" || text[index] === "[") {
        stack.push(text[index] === "{" ? "}" : "]");
      } else if (text[index] === stack.at(-1)) {
        stack.pop();
        if (stack.length === 0) return index + 1;
      }
    }
    return null;
  }
  let end = start;
  while (end < text.length && ![",", "}", "]", "\n", "\r"].includes(text[end])) end += 1;
  return end > start ? end : null;
}

function redactYamlBlocks(text, fields) {
  const lines = text.split("\n");
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const indentationText = /^\s*/.exec(line)[0];
    let keyStart = indentationText.length;
    const sequenceMarker = /^-\s+/.exec(line.slice(keyStart));
    if (sequenceMarker) keyStart += sequenceMarker[0].length;
    const candidate = readKey(line, keyStart);
    let colon = candidate?.end ?? -1;
    while (colon >= 0 && colon < line.length && /[ \t]/.test(line[colon])) colon += 1;
    if (!candidate || line[colon] !== ":" || !fields.has(candidate.key)) {
      output.push(lines[index]);
      continue;
    }
    output.push(`${line.slice(0, colon + 1)} ${JSON.stringify(REDACTED)}`);
    const indentation = indentationText.length;
    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      if (!next.trim()) {
        index += 1;
        continue;
      }
      const nextIndentation = /^\s*/.exec(next)[0].length;
      const indentlessSequence = !sequenceMarker
        && nextIndentation === indentation
        && /^-\s/.test(next.slice(indentation));
      if (nextIndentation < indentation || (nextIndentation === indentation && !indentlessSequence)) {
        break;
      }
      index += 1;
    }
  }
  return output.join("\n");
}

function readKey(text, start) {
  if (text[start] === '"' || text[start] === "'") {
    const end = parseQuotedStringEnd(text, start);
    if (end === null) return null;
    let key = text.slice(start + 1, end - 1);
    if (text[start] === '"') {
      try {
        key = JSON.parse(text.slice(start, end));
      } catch {
        return { key: null, end };
      }
    }
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) return { key: null, end };
    return { key, end };
  }
  if (!/[A-Za-z_]/.test(text[start] ?? "")) return null;
  if (start > 0 && /[A-Za-z0-9_-]/.test(text[start - 1])) return null;
  let end = start + 1;
  while (/[A-Za-z0-9_-]/.test(text[end] ?? "")) end += 1;
  return { key: text.slice(start, end), end };
}

function redactEmbeddedStructuredFields(text, fields) {
  const source = redactYamlBlocks(text, fields);
  let output = "";
  let cursor = 0;
  let index = 0;
  while (index < source.length) {
    const candidate = readKey(source, index);
    if (!candidate) {
      index += 1;
      continue;
    }
    let colon = candidate.end;
    while (colon < source.length && /\s/.test(source[colon])) colon += 1;
    if (source[colon] !== ":" || !fields.has(candidate.key)) {
      index = candidate.end;
      continue;
    }
    let valueStart = colon + 1;
    while (valueStart < source.length && /\s/.test(source[valueStart])) valueStart += 1;
    const valueEnd = parseStructuredValueEnd(source, valueStart);
    output += source.slice(cursor, valueStart) + JSON.stringify(REDACTED);
    if (valueEnd === null) {
      const lineEnd = source.indexOf("\n", valueStart);
      cursor = lineEnd === -1 ? source.length : lineEnd;
      index = cursor;
    } else {
      cursor = valueEnd;
      index = valueEnd;
    }
  }
  return output + source.slice(cursor);
}

export function redactEvidenceText(value, evidenceRedaction = null) {
  const text = String(value ?? "");
  const jsonFields = evidenceRedaction?.jsonFields ?? [];
  if (jsonFields.length === 0 || !text) return text;
  const fields = new Set(jsonFields);
  const lines = text.split("\n");
  const parsedLines = [];
  let parsedAny = false;
  let allJson = true;
  for (const line of lines) {
    if (!line.trim()) {
      parsedLines.push(line);
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      const redacted = JSON.stringify(redactParsedValue(parsed, fields, 0));
      // Re-serializing rewrites escapes and number spellings even when nothing
      // was removed, and a Judge scores the bytes it is given. Keep the original
      // line unless redaction actually took something out, so declaring a field
      // cannot move a score on its own.
      parsedLines.push(redacted === JSON.stringify(parsed) ? line : redacted);
      parsedAny = true;
    } catch {
      allJson = false;
      break;
    }
  }
  if (allJson && parsedAny) return parsedLines.join("\n");
  return redactEmbeddedStructuredFields(text, fields);
}
