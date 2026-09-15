import { copyFile, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveV1Suite } from "./v1-authoring.mjs";

const starterTemplateRoot = new URL("../../examples/copy-message/", import.meta.url);
const STARTER_FILES = Object.freeze([
  "README.md",
  "example.suite.mjs",
  "tasks/copy-message/prompt.md",
  "tasks/copy-message/checks.mjs",
  "tasks/copy-message/fixtures/message.txt",
]);

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

export async function initializeSuite({ destination } = {}) {
  if (!isAbsolute(destination ?? "")) {
    throw new TypeError("destination must be an absolute path");
  }

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
    temporaryRoot = await mkdtemp(join(parent, `.${basename(destination)}.tae-init-`));
    for (const relativePath of STARTER_FILES) {
      const outputPath = join(temporaryRoot, ...relativePath.split("/"));
      await mkdir(dirname(outputPath), { recursive: true });
      await copyFile(
        fileURLToPath(new URL(relativePath, starterTemplateRoot)),
        outputPath,
      );
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
