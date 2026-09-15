import { createHash } from "node:crypto";

import { deepFreeze } from "./run-model.mjs";

export const EXCHANGE_FACT_CAPTURE_PROFILE = "bounded-json-exchange-facts-v1";

const SENSITIVE_POINTER_TERMS = Object.freeze([
  "prompt",
  "content",
  "answer",
  "text",
  "reasoning",
  "output",
  "secret",
  "password",
  "authorization",
  "cookie",
  "token",
  "input",
  "embedding",
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function compareId(left, right) {
  return left.id.localeCompare(right.id);
}

function normalizeSelector(selector) {
  return {
    id: selector.id,
    pointer: selector.pointer,
    ...(selector.maxMatches === undefined ? {} : { maxMatches: selector.maxMatches }),
    projection: structuredClone(selector.projection),
  };
}

const PATH_SEGMENT_TEMPLATE = "{segment}";

function matchPaths(match) {
  return Array.isArray(match.paths) ? match.paths : [];
}

function matchPathTemplates(match) {
  return Array.isArray(match.pathTemplates) ? match.pathTemplates : [];
}

export function normalizeExchangeFactProfiles(profiles = []) {
  const normalized = profiles.map((profile) => ({
    id: profile.id,
    match: {
      method: profile.match.method,
      ...(profile.match.paths === undefined
        ? { pathTemplates: [...profile.match.pathTemplates].sort() }
        : { paths: [...profile.match.paths].sort() }),
      statusCodes: [...profile.match.statusCodes].sort((left, right) => left - right),
    },
    requestJson: profile.requestJson.map(normalizeSelector).sort(compareId),
    responseJson: profile.responseJson.map(normalizeSelector).sort(compareId),
  })).sort(compareId);
  return deepFreeze(normalized);
}

function decodePointerSegment(segment) {
  if (/~(?:[^01]|$)/u.test(segment)) return null;
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function pointerDiagnostic(selector, pointer) {
  if (Buffer.byteLength(selector.pointer) > 256) {
    return {
      code: "egress.exchange-fact-pointer-invalid",
      pointer,
      message: "Exchange-fact pointers may not exceed 256 UTF-8 bytes.",
    };
  }
  const encodedSegments = selector.pointer.slice(1).split("/");
  if (encodedSegments.length > 16) {
    return {
      code: "egress.exchange-fact-pointer-invalid",
      pointer,
      message: "Exchange-fact pointers may not exceed 16 segments.",
    };
  }
  const decodedSegments = encodedSegments.map(decodePointerSegment);
  if (decodedSegments.some((segment) => segment === null)) {
    return {
      code: "egress.exchange-fact-pointer-invalid",
      pointer,
      message: "Exchange-fact pointers must use RFC 6901 escaping.",
    };
  }
  const wildcardCount = decodedSegments.filter((segment) => segment === "*").length;
  if (wildcardCount > 2) {
    return {
      code: "egress.exchange-fact-pointer-invalid",
      pointer,
      message: "Exchange-fact pointers may contain at most two array wildcards.",
    };
  }
  if ((wildcardCount > 0) !== (selector.maxMatches !== undefined)) {
    return {
      code: "egress.exchange-fact-pointer-invalid",
      pointer,
      message: wildcardCount > 0
        ? "Wildcard exchange-fact selectors must declare maxMatches."
        : "Exchange-fact selectors without wildcards must not declare maxMatches.",
    };
  }
  const sensitive = decodedSegments.find((segment) => {
    if (segment === "*") return false;
    const normalized = segment.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
    return SENSITIVE_POINTER_TERMS.some((term) => normalized.includes(term));
  });
  if (sensitive !== undefined) {
    return {
      code: "egress.exchange-fact-pointer-sensitive",
      pointer,
      message: "Exchange-fact pointers may not select content or credential payloads.",
    };
  }
  return null;
}

function selectorDiagnostics(selectors, pointer) {
  const diagnostics = [];
  const ids = new Set();
  for (const [index, selector] of selectors.entries()) {
    const selectorPointer = `${pointer}/${index}`;
    if (ids.has(selector.id)) {
      diagnostics.push({
        code: "egress.exchange-fact-selector-duplicate",
        pointer: `${selectorPointer}/id`,
        message: `Exchange-fact selector '${selector.id}' is declared more than once on this side.`,
      });
    }
    ids.add(selector.id);
    const projection = selector.projection;
    const projectionKeys = projection && typeof projection === "object"
      ? Object.keys(projection).sort()
      : [];
    const validProjection = (
      projection?.kind === "present"
      && JSON.stringify(projectionKeys) === JSON.stringify(["kind"])
    ) || (
      projection?.kind === "count"
      && JSON.stringify(projectionKeys) === JSON.stringify(["kind", "maxItems"])
      && Number.isSafeInteger(projection.maxItems)
      && projection.maxItems >= 0
      && projection.maxItems <= 4096
    ) || (
      projection?.kind === "sha256-string"
      && JSON.stringify(projectionKeys) === JSON.stringify(["kind", "maxInputBytes"])
      && Number.isSafeInteger(projection.maxInputBytes)
      && projection.maxInputBytes >= 1
      && projection.maxInputBytes <= 65_536
    );
    if (!validProjection) {
      diagnostics.push({
        code: "egress.exchange-fact-projection-invalid",
        pointer: `${selectorPointer}/projection`,
        message: "Exchange-fact projections must be bounded presence, count, or SHA-256 string projections.",
      });
    }
    const diagnostic = pointerDiagnostic(selector, `${selectorPointer}/pointer`);
    if (diagnostic) diagnostics.push(diagnostic);
  }
  return diagnostics;
}

function validMatchPath(path) {
  return path.startsWith("/")
    && Buffer.byteLength(path) <= 4096
    && !path.includes("?")
    && !path.includes("#");
}

function pathTemplateSegments(template) {
  if (!validMatchPath(template)) return null;
  const segments = template.split("/").slice(1);
  const placeholders = segments.filter((segment) => segment === PATH_SEGMENT_TEMPLATE).length;
  if (
    placeholders < 1
    || placeholders > 4
    || segments.some((segment) => (
      segment.length === 0
      || (segment.includes("{") || segment.includes("}"))
        && segment !== PATH_SEGMENT_TEMPLATE
    ))
  ) return null;
  return segments;
}

function pathMatchesTemplate(template, path) {
  if (!validMatchPath(path)) return false;
  const templateSegments = pathTemplateSegments(template);
  const pathSegments = path.split("/").slice(1);
  if (!templateSegments || templateSegments.length !== pathSegments.length) return false;
  return templateSegments.every((segment, index) => (
    segment === PATH_SEGMENT_TEMPLATE
      ? Buffer.byteLength(pathSegments[index]) >= 1
        && Buffer.byteLength(pathSegments[index]) <= 512
      : segment === pathSegments[index]
  ));
}

function pathShapesOverlap(left, right) {
  const leftSegments = left.includes(PATH_SEGMENT_TEMPLATE)
    ? pathTemplateSegments(left) : left.split("/").slice(1);
  const rightSegments = right.includes(PATH_SEGMENT_TEMPLATE)
    ? pathTemplateSegments(right) : right.split("/").slice(1);
  return Boolean(leftSegments && rightSegments)
    && leftSegments.length === rightSegments.length
    && leftSegments.every((segment, index) => (
      segment === PATH_SEGMENT_TEMPLATE
      || rightSegments[index] === PATH_SEGMENT_TEMPLATE
      || segment === rightSegments[index]
    ));
}

function profileMatchesPath(profile, path) {
  return matchPaths(profile.match).includes(path)
    || matchPathTemplates(profile.match).some((template) => pathMatchesTemplate(template, path));
}

export function exchangeFactProfileMatchesEvent(profile, event) {
  return event?.kind === "http-request"
    && event.method === profile?.match?.method
    && profileMatchesPath(profile, event.path)
    && profile.match.statusCodes.includes(event.statusCode);
}

export function exchangeFactProfileDiagnostics(
  profiles = [],
  { pointer = "", relevantHosts = null } = {},
) {
  const diagnostics = [];
  if (profiles.length > 0 && Array.isArray(relevantHosts) && relevantHosts.length === 0) {
    diagnostics.push({
      code: "egress.exchange-fact-hosts-required",
      pointer,
      message: "Exchange-fact profiles require at least one relevant egress host.",
    });
  }
  const profileIds = new Set();
  const matchOwners = new Map();
  let selectorCount = 0;
  for (const [profileIndex, profile] of profiles.entries()) {
    const profilePointer = `${pointer}/${profileIndex}`;
    if (profileIds.has(profile.id)) {
      diagnostics.push({
        code: "egress.exchange-fact-profile-duplicate",
        pointer: `${profilePointer}/id`,
        message: `Exchange-fact profile '${profile.id}' is declared more than once.`,
      });
    }
    profileIds.add(profile.id);
    const profileSelectorCount = profile.requestJson.length + profile.responseJson.length;
    selectorCount += profileSelectorCount;
    if (profileSelectorCount < 1 || profileSelectorCount > 24) {
      diagnostics.push({
        code: "egress.exchange-fact-selector-limit",
        pointer: profilePointer,
        message: "Each exchange-fact profile must declare between 1 and 24 selectors.",
      });
    }
    diagnostics.push(
      ...selectorDiagnostics(profile.requestJson, `${profilePointer}/requestJson`),
      ...selectorDiagnostics(profile.responseJson, `${profilePointer}/responseJson`),
    );
    const paths = matchPaths(profile.match);
    const pathTemplates = matchPathTemplates(profile.match);
    if (
      (paths.length === 0) === (pathTemplates.length === 0)
      || !Array.isArray(profile.match.paths ?? [])
      || !Array.isArray(profile.match.pathTemplates ?? [])
    ) {
      diagnostics.push({
        code: "egress.exchange-fact-match-invalid",
        pointer: `${profilePointer}/match`,
        message: "Exchange-fact matches must declare exactly one of paths or pathTemplates.",
      });
    }
    for (const [pathIndex, path] of paths.entries()) {
      if (!validMatchPath(path) || path.includes("{") || path.includes("}")) {
        diagnostics.push({
          code: "egress.exchange-fact-match-invalid",
          pointer: `${profilePointer}/match/paths/${pathIndex}`,
          message: "Exchange-fact match paths must be normalized absolute paths without query or fragment.",
        });
      }
    }
    for (const [templateIndex, template] of pathTemplates.entries()) {
      if (!pathTemplateSegments(template)) {
        diagnostics.push({
          code: "egress.exchange-fact-match-invalid",
          pointer: `${profilePointer}/match/pathTemplates/${templateIndex}`,
          message: "Exchange-fact path templates may contain one to four whole-segment {segment} placeholders.",
        });
      }
    }
    for (const pathShape of [...paths, ...pathTemplates]) {
      for (const statusCode of profile.match.statusCodes) {
        const overlapping = [...matchOwners.entries()].find(([key]) => {
          const [method, ownerShape, ownerStatus] = key.split("\0");
          return method === profile.match.method
            && Number(ownerStatus) === statusCode
            && pathShapesOverlap(ownerShape, pathShape);
        });
        if (overlapping !== undefined) {
          diagnostics.push({
            code: "egress.exchange-fact-match-overlap",
            pointer: `${profilePointer}/match`,
            message: `Exchange-fact profile '${profile.id}' overlaps '${overlapping[1]}' for an HTTP match.`,
          });
        } else {
          matchOwners.set(`${profile.match.method}\0${pathShape}\0${statusCode}`, profile.id);
        }
      }
    }
  }
  if (selectorCount > 64) {
    diagnostics.push({
      code: "egress.exchange-fact-selector-limit",
      pointer,
      message: "An effective egress policy may declare at most 64 exchange-fact selectors.",
    });
  }
  return diagnostics;
}

export function compileExchangeFactProfiles(profiles = []) {
  if (profiles.length === 0) return null;
  const diagnostics = exchangeFactProfileDiagnostics(profiles);
  if (diagnostics.length > 0) {
    throw new TypeError("Exchange-fact profiles are invalid");
  }
  const normalized = normalizeExchangeFactProfiles(profiles);
  const preimage = canonicalize({
    kind: "tae.exchange-fact-policy",
    fingerprintVersion: 1,
    profiles: normalized,
  });
  const policyFingerprint = `sha256:${createHash("sha256")
    .update(JSON.stringify(preimage))
    .digest("hex")}`;
  return deepFreeze({
    schemaVersion: 1,
    captureProfile: EXCHANGE_FACT_CAPTURE_PROFILE,
    policyFingerprint,
    profiles: normalized,
  });
}

function hasExactKeys(value, expected) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && Object.keys(value).every((key) => expected.includes(key));
}

function decodePointer(pointer) {
  return pointer.slice(1).split("/").map(decodePointerSegment);
}

function resolvedPointerMatches(pattern, resolved) {
  if (typeof resolved !== "string" || !resolved.startsWith("/")) return false;
  const patternSegments = decodePointer(pattern);
  const resolvedSegments = decodePointer(resolved);
  if (
    patternSegments.some((segment) => segment === null)
    || resolvedSegments.some((segment) => segment === null || segment === "*")
    || patternSegments.length !== resolvedSegments.length
  ) {
    return false;
  }
  return patternSegments.every((segment, index) => (
    segment === "*"
      ? /^(?:0|[1-9][0-9]*)$/u.test(resolvedSegments[index])
      : segment === resolvedSegments[index]
  ));
}

function validProjectedValue(value, projection) {
  if (projection.kind === "present") return value === true;
  if (projection.kind === "count") {
    return Number.isSafeInteger(value) && value >= 0 && value <= projection.maxItems;
  }
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function normalizeFactResult(result, selector) {
  if (hasExactKeys(result, ["state"]) && result.state === "absent") {
    return { state: "absent" };
  }
  if (
    !hasExactKeys(result, ["state", "matches"])
    || result.state !== "present"
    || !Array.isArray(result.matches)
    || result.matches.length < 1
    || result.matches.length > (selector.maxMatches ?? 1)
  ) {
    throw new TypeError("Execution Environment returned invalid exchange facts");
  }
  const pointers = new Set();
  const matches = result.matches.map((match) => {
    if (
      !hasExactKeys(match, ["pointer", "value"])
      || !resolvedPointerMatches(selector.pointer, match.pointer)
      || pointers.has(match.pointer)
      || !validProjectedValue(match.value, selector.projection)
    ) {
      throw new TypeError("Execution Environment returned invalid exchange facts");
    }
    pointers.add(match.pointer);
    return { pointer: match.pointer, value: match.value };
  });
  return { state: "present", matches };
}

function normalizeFactSide(side, selectors) {
  const expectedIds = selectors.map(({ id }) => id).sort();
  if (!hasExactKeys(side, expectedIds)) {
    throw new TypeError("Execution Environment returned invalid exchange facts");
  }
  return Object.fromEntries(selectors.map((selector) => [
    selector.id,
    normalizeFactResult(side[selector.id], selector),
  ]));
}

export function normalizeExchangeFacts(observed, compiledPolicy, event) {
  if (
    !compiledPolicy
    || !hasExactKeys(observed, [
      "schemaVersion",
      "captureProfile",
      "policyFingerprint",
      "profileId",
      "request",
      "response",
    ])
    || observed.schemaVersion !== 1
    || observed.captureProfile !== EXCHANGE_FACT_CAPTURE_PROFILE
    || observed.policyFingerprint !== compiledPolicy.policyFingerprint
  ) {
    throw new TypeError("Execution Environment returned invalid exchange facts");
  }
  const profile = compiledPolicy.profiles.find(({ id }) => id === observed.profileId);
  if (
    !profile
    || !exchangeFactProfileMatchesEvent(profile, event)
  ) {
    throw new TypeError("Execution Environment returned invalid exchange facts");
  }
  const normalized = {
    schemaVersion: 1,
    captureProfile: EXCHANGE_FACT_CAPTURE_PROFILE,
    policyFingerprint: compiledPolicy.policyFingerprint,
    profileId: profile.id,
    request: normalizeFactSide(observed.request, profile.requestJson),
    response: normalizeFactSide(observed.response, profile.responseJson),
  };
  const factMatches = [...Object.values(normalized.request), ...Object.values(normalized.response)]
    .reduce((count, result) => count + (result.matches?.length ?? 0), 0);
  if (factMatches > 128 || Buffer.byteLength(JSON.stringify(normalized)) > 64 * 1024) {
    throw new TypeError("Execution Environment returned invalid exchange facts");
  }
  return deepFreeze(normalized);
}
