// Matching labels are insufficient: compare only the same recorded definition.
export function sameRecordedDefinition(left, right) {
  return typeof left.snapshotFingerprint === "string"
    && /^sha256:[a-f0-9]{64}$/.test(left.snapshotFingerprint)
    && left.snapshotFingerprint === right.snapshotFingerprint;
}
