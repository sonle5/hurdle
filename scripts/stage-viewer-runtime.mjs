import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const standaloneRoot = join(root, "viewer/.next/standalone/viewer");
const staticRoot = join(root, "viewer/.next/static");
const publicRoot = join(root, "viewer/public");
const outputRoot = join(root, "viewer-runtime");

for (const required of [join(standaloneRoot, "server.js"), staticRoot]) {
  if (!existsSync(required)) {
    throw new Error(`Viewer build output is missing: ${required}`);
  }
}

rmSync(outputRoot, { recursive: true, force: true });
cpSync(standaloneRoot, outputRoot, { recursive: true });

const installedModules = join(outputRoot, "node_modules");
const runtimeModules = join(outputRoot, "runtime_modules");
renameSync(installedModules, runtimeModules);

// The Viewer does not use next/image. Excluding Sharp keeps this runtime
// platform-neutral instead of publishing the build machine's native binary.
rmSync(join(runtimeModules, "sharp"), { recursive: true, force: true });
rmSync(join(runtimeModules, "@img"), { recursive: true, force: true });

const staticOutput = join(outputRoot, ".next/static");
mkdirSync(staticOutput, { recursive: true });
cpSync(staticRoot, staticOutput, { recursive: true });
if (existsSync(publicRoot)) cpSync(publicRoot, join(outputRoot, "public"), { recursive: true });

// File tracing omits licenses that are not imported by the server. Include
// notices for production dependencies, including code bundled into client JS.
function dependencyNotices(directory, prefix = "") {
  const notices = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const label = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory() && entry.name !== "node_modules") {
      notices.push(...dependencyNotices(path, label));
    } else if (entry.isFile() && /^(?:licen[cs]e|notice|copying)(?:[._-]|$)/i.test(entry.name)) {
      notices.push(`### ${label}\n\n${readFileSync(path, "utf8")}`);
    }
  }
  return notices;
}

const viewerLock = JSON.parse(readFileSync(join(root, "viewer/package-lock.json"), "utf8"));
const notices = [];
for (const [path, metadata] of Object.entries(viewerLock.packages)) {
  if (!path.startsWith("node_modules/") || metadata.dev) continue;
  const directory = join(root, "viewer", path);
  if (!existsSync(directory)) continue;
  const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  notices.push(`## ${name}@${metadata.version}\nLicense: ${metadata.license ?? "See notices below"}\n\n${dependencyNotices(directory).join("\n\n")}`);
}
writeFileSync(join(outputRoot, "THIRD_PARTY_NOTICES.txt"),
  `Third-party notices for bundled Viewer dependencies.\nEach dependency retains its own license.\n\n${notices.join("\n\n---\n\n")}\n`);

function findNativeModules(directory) {
  const matches = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) matches.push(...findNativeModules(path));
    else if (entry.isFile() && entry.name.endsWith(".node")) matches.push(path);
  }
  return matches;
}

const nativeModules = findNativeModules(outputRoot);
if (nativeModules.length > 0) {
  throw new Error(`Packaged Viewer contains native modules: ${nativeModules.join(", ")}`);
}

process.stdout.write("Staged portable Viewer runtime.\n");
