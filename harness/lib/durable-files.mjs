import { randomUUID } from "node:crypto";
import {
  link,
  open,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";

export async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function publishFileExclusive(directory, name, bytes) {
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  const destination = join(directory, name);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, destination);
    await syncDirectory(directory);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
