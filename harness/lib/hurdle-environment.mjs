export const RESULT_STORE_DATABASE_URL_ENV = "HURDLE_RESULT_STORE_DATABASE_URL";
const LEGACY_DATABASE_URL_ENV = "TAE_RESULT_STORE_DATABASE_URL";

export function canonicalEnvironmentName(name) {
  return name === LEGACY_DATABASE_URL_ENV ? RESULT_STORE_DATABASE_URL_ENV : name;
}

// Explicit Hurdle values, including empty ones, take precedence over the alias.
export function hurdleEnvironmentValue(environment, name) {
  const canonical = canonicalEnvironmentName(name);
  if (Object.hasOwn(environment ?? {}, canonical)) return environment[canonical];
  if (canonical === RESULT_STORE_DATABASE_URL_ENV) return environment?.[LEGACY_DATABASE_URL_ENV];
  return environment?.[name];
}

export function withHurdleEnvironment(environment) {
  const result = { ...environment };
  if (!Object.hasOwn(result, RESULT_STORE_DATABASE_URL_ENV)
    && Object.hasOwn(result, LEGACY_DATABASE_URL_ENV)) {
    result[RESULT_STORE_DATABASE_URL_ENV] = result[LEGACY_DATABASE_URL_ENV];
  }
  return result;
}
