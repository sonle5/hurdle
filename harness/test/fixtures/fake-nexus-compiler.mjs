// A stand-in for `python3 -m nexus_compiler` on the controller host. It never
// reaches a cluster: it answers each verb from its argv and FAKE_ENGINE_MODE.
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_ENGINE_MODE ?? "";

function readStdin() {
  return new Promise((done) => {
    const parts = [];
    process.stdin.on("data", (chunk) => parts.push(chunk));
    process.stdin.once("end", () => done(Buffer.concat(parts)));
  });
}

// One ustar entry, then the two zero blocks that end the archive.
function tar(name, body) {
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([header, padded, Buffer.alloc(1024)]);
}

if (mode === "hang") {
  process.on("SIGTERM", () => {
    writeFileSync(process.env.FAKE_ENGINE_MARKER, "SIGTERM");
    process.exit(143);
  });
  process.stdout.write("started\n");
  setInterval(() => {}, 1000);
} else if (argv[1] === "records") {
  if (mode === "big") {
    process.stdout.write(Buffer.alloc(4096, 1));
    setInterval(() => {}, 1000);
  } else {
    // A body of zeros: the end marker must be found by block, not by bytes.
    const archive = tar("records/r.json", Buffer.alloc(2048));
    process.stdout.write(mode === "unterminated" ? archive.subarray(0, 1024) : archive);
    if (mode === "unterminated") process.exitCode = 0;
    else await readStdin();
  }
} else {
  const stdin = await readStdin();
  process.stdout.write(`${JSON.stringify({ argv, stdin: stdin.toString("utf8"), secret: process.env.ENGINE_SECRET ?? null })}\n`);
  process.stderr.write("fake engine stderr\n");
  process.exitCode = Number(process.env.FAKE_ENGINE_EXIT ?? 0);
}
