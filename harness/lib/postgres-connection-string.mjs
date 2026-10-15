const PG8_STRICT_SSL_ALIASES = new Set(["prefer", "require", "verify-ca"]);

export function normalizePostgresConnectionString(connectionString) {
  try {
    const parsed = new URL(connectionString);
    const sslMode = parsed.searchParams.get("sslmode");
    if (!PG8_STRICT_SSL_ALIASES.has(sslMode)) return connectionString;

    // pg 8 treats these modes as verify-full and warns that pg 9 will not.
    // Preserve today's stronger behavior explicitly for every Postgres path.
    parsed.searchParams.set("sslmode", "verify-full");
    return parsed.toString();
  } catch {
    return connectionString;
  }
}

const TLS_FAILURES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

// Name why a connection failed in fixed words. Driver messages can contain
// the host, user and database names, so they are never shown.
export function postgresConnectionFailure(error) {
  const code = error?.code;
  const message = String(error?.message ?? "");
  if (code === "28P01" || code === "28000") return "credential rejected; check the user name and password in the connection URL";
  if (code === "3D000") return "the database named in the connection URL does not exist";
  if (code === "42501") return "the credential lacks permission on this database";
  if (code === "53300") return "the server has too many connections; try again later";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "the host in the connection URL could not be resolved";
  if (code === "ECONNREFUSED") return "the server refused the connection; check the host and port, and that Postgres is running";
  if (code === "ETIMEDOUT" || /connection timeout|timeout expired/i.test(message)) return "the connection timed out; check the host, port and network access";
  if (TLS_FAILURES.has(code) || /does not support SSL/i.test(message)) return "the TLS connection failed; check sslmode and the server certificate";
  if (code === "ERR_INVALID_URL") return "the connection URL is invalid";
  return "database could not be reached";
}
