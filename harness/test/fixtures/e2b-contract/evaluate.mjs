const REQUIRED_REQUESTS = Object.freeze([
  ["chat-completion", "/v1/chat/completions"],
  ["image-generation", "/v1/images/generations"],
  ["audio-transcription", "/v1/audio/transcriptions"],
]);

export function evaluate({ assertions, snapshot, egress, readArtifactBytes }) {
  const { createCheck, detectImageFormat, isSuccessfulHttpStatus } = assertions;
  const relevantHosts = new Set(snapshot.target.egress.relevantHosts);
  const captured = egress.filter((collection) => (
    collection.status === "captured"
    && collection.provenance?.lifecyclePhase === "execution"
    && ["controller-observed", "environment-observed"].includes(
      collection.provenance?.trust,
    )
  ));
  const captureAvailable = captured.length > 0;
  const requests = captured.flatMap((collection) => collection.requests)
    .filter((request) => relevantHosts.has(request.host));
  const successfulRequests = {};
  const checks = REQUIRED_REQUESTS.map(([id, path]) => {
    if (!captureAvailable) {
      successfulRequests[id] = null;
      return {
        id,
        required: true,
        outcome: "skip",
        summary: "Trusted egress capture was unavailable.",
        evidenceRefs: [],
      };
    }
    const matching = requests.filter((request) => (
      request.method === "POST"
      && request.path === path
      && isSuccessfulHttpStatus(request.statusCode)
    ));
    successfulRequests[id] = matching.length;
    return {
      id,
      required: true,
      outcome: matching.length > 0 ? "pass" : "fail",
      summary: matching.length > 0
        ? `Observed a successful POST to ${path}.`
        : `No successful POST to ${path} was observed.`,
      evidenceRefs: [...new Set(matching.map(({ evidenceRef }) => evidenceRef))],
    };
  });

  const image = readArtifactBytes("outputs/generated-image");
  const format = image.status === "present"
    ? detectImageFormat(image.bytes)
    : null;
  checks.push(createCheck({
    id: "saved-image-artifact",
    required: false,
    valid: Boolean(format),
    passSummary: `The saved image has a recognized ${format?.toUpperCase()} signature.`,
    failSummary: "The optional saved image is missing or has an unrecognized signature.",
    evidenceRefs: image.evidenceRef ? [image.evidenceRef] : [],
  }));

  return {
    checks,
    targetMetrics: {
      successfulRequests,
      totalRelevantRequests: captureAvailable ? requests.length : null,
      savedImageBytes: image.status === "present" ? image.bytes.byteLength : null,
    },
  };
}
