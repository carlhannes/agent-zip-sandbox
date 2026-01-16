import fs from "node:fs/promises";
import { atomicWriteFile } from "./persist.js";

async function fileExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

export async function loadChatState(chatPath) {
  const exists = await fileExists(chatPath);
  if (!exists) return null;
  const raw = await fs.readFile(chatPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") return null;
  if (!Array.isArray(parsed.messages)) return null;
  return parsed;
}

export async function saveChatState(chatPath, state) {
  const out = {
    ...state,
    version: state?.version ?? 1,
    updatedAt: new Date().toISOString()
  };
  const json = JSON.stringify(out, null, 2) + "\n";
  await atomicWriteFile(chatPath, json);
  return { ok: true, bytes: Buffer.byteLength(json, "utf8") };
}

