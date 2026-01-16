import fs from "node:fs/promises";
import path from "node:path";

export async function atomicWriteFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (dir && dir !== ".") {
    await fs.mkdir(dir, { recursive: true });
  }

  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, data);

  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    // Best-effort Windows/edge-case fallback when rename can't overwrite.
    if (err?.code === "EEXIST" || err?.code === "EPERM") {
      await fs.rm(filePath, { force: true });
      await fs.rename(tmpPath, filePath);
      return;
    }
    try {
      await fs.rm(tmpPath, { force: true });
    } catch {
      // ignore
    }
    throw err;
  }
}

