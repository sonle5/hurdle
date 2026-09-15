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
