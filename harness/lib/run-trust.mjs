function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function deriveRunTrust({ integrityIssues = [] } = {}) {
  if (!Array.isArray(integrityIssues)) {
    throw new TypeError("Integrity Issues must be an array");
  }
  for (const issue of integrityIssues) {
    if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
      throw new TypeError("Integrity Issue is invalid");
    }
    if (!["incomplete", "unknown"].includes(issue.effect)) {
      throw new TypeError("Integrity Issue effect is invalid");
    }
    if (
      typeof issue.code !== "string"
      || issue.code.trim() === ""
      || typeof issue.message !== "string"
      || issue.message.trim() === ""
    ) {
      throw new TypeError("Integrity Issue reason is invalid");
    }
  }
  const status = integrityIssues.some(({ effect }) => effect === "incomplete")
    ? "incomplete"
    : integrityIssues.some(({ effect }) => effect === "unknown")
      ? "unknown"
      : "trusted";
  return freeze({
    schemaVersion: 1,
    status,
    reasons: integrityIssues.map((issue) => ({
      code: issue.code,
      summary: issue.message,
      evidenceRefs: [],
    })),
  });
}
