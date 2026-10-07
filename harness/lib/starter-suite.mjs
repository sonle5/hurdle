import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveV1Suite } from "./v1-authoring.mjs";

const STARTERS = Object.freeze({ "copy-message": [
  "README.md",
  "example.suite.mjs",
  "tasks/copy-message/prompt.md",
  "tasks/copy-message/checks.mjs",
  "tasks/copy-message/fixtures/message.txt",
], "together-api": [
  "README.md", "example.suite.mjs", "tasks/together-api/prompt.md",
  "tasks/together-api/checks.mjs", "tasks/together-api/fixtures/request.json",
] });

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function initDiagnostic(code, destination, message) {
  return {
    ok: false,
    diagnostics: [
      {
        code,
        file: destination,
        message,
      },
    ],
  };
}

export async function initializeSuite({ destination, agent = "claude-code", example = "copy-message" } = {}) {
  if (!isAbsolute(destination ?? "")) {
    throw new TypeError("destination must be an absolute path");
  }
  if (!["claude-code", "codex"].includes(agent)) {
    return initDiagnostic("init.agent-invalid", destination, "Choose claude-code or codex for the starter Agent.");
  }
  if (!Object.hasOwn(STARTERS, example)) return initDiagnostic("init.example-invalid", destination, "Choose copy-message or together-api.");
  const starterTemplateRoot = new URL(`../../examples/${example}/`, import.meta.url);
  const STARTER_FILES = STARTERS[example];

  if (await pathExists(destination)) {
    return initDiagnostic(
      "init.destination-exists",
      destination,
      "Destination already exists.",
    );
  }

  const parent = dirname(destination);
  let parentStat;
  try {
    parentStat = await lstat(parent);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return initDiagnostic(
        "init.parent-missing",
        destination,
        "Destination parent does not exist.",
      );
    }
    return initDiagnostic(
      "init.write-failed",
      destination,
      "Starter evaluation could not be created.",
    );
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    return initDiagnostic(
      "init.parent-invalid",
      destination,
      "Destination parent must be a non-symlink directory.",
    );
  }

  let temporaryRoot;
  try {
    temporaryRoot = await mkdtemp(join(parent, `.${basename(destination)}.hurdle-init-`));
    for (const relativePath of STARTER_FILES) {
      const outputPath = join(temporaryRoot, ...relativePath.split("/"));
      await mkdir(dirname(outputPath), { recursive: true });
      await copyFile(
        fileURLToPath(new URL(relativePath, starterTemplateRoot)),
        outputPath,
      );
    }
    if (agent === "codex") {
      const suitePath = join(temporaryRoot, "example.suite.mjs");
      const source = await readFile(suitePath, "utf8");
      await writeFile(suitePath, source.replace('runner: "claude-code"', 'runner: "codex"'));
    }

    const resolved = await resolveV1Suite({
      suitePath: join(temporaryRoot, "example.suite.mjs"),
    });
    resolved.dispose();
    if (!resolved.ok) {
      return {
        ok: false,
        diagnostics: [
          {
            code: "init.template-invalid",
            file: destination,
            message: "Packaged starter evaluation is invalid.",
          },
          ...resolved.diagnostics,
        ],
      };
    }
    if (await pathExists(destination)) {
      return initDiagnostic(
        "init.destination-exists",
        destination,
        "Destination already exists.",
      );
    }

    await rename(temporaryRoot, destination);
    temporaryRoot = undefined;
    return {
      ok: true,
      value: {
        root: destination,
        suitePath: join(destination, "example.suite.mjs"),
        createdFiles: [...STARTER_FILES],
        definitionFingerprint: resolved.value.definitionFingerprint,
      },
      diagnostics: [],
    };
  } catch (error) {
    if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") {
      return initDiagnostic(
        "init.destination-exists",
        destination,
        "Destination already exists.",
      );
    }
    return initDiagnostic(
      "init.write-failed",
      destination,
      "Starter evaluation could not be created.",
    );
  } finally {
    if (temporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}
