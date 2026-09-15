import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export class BackendDependencyError extends Error {
  constructor(backend) {
    super(`${backend} dependencies are not installed. Run npm run setup:backends from the repository root.`);
    this.code = "backend-not-installed";
  }
}

// Check installation only: never allocate a sandbox or connect to a database.
export function assertRuntimeDependencies({ environment }) {
  if (environment?.kind !== "e2b") return;
  for (const name of ["e2b", "https-proxy-agent", "ws"]) {
    try {
      require.resolve(name);
    } catch (error) {
      if (error?.code !== "MODULE_NOT_FOUND") throw error;
      throw new BackendDependencyError("E2B");
    }
  }
}
