import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ZipWorkspace } from "./workspace.js";
import { createWorkspaceTools } from "./tools.js";
import { atomicWriteFile } from "./persist.js";

const SANDBOX_RUNNER_PATH = fileURLToPath(new URL("./sandbox_runner.js", import.meta.url));
const DEFAULT_EXEC_TIMEOUT_MS = 1500;
const DEFAULT_SEARCH_MAX_RESULTS = 8;
const DEFAULT_SEARCH_CONTEXT_LINES = 2;

async function fileExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

export async function loadWorkspaceFromZipPath(zipPath) {
  const exists = await fileExists(zipPath);
  if (!exists) return { workspace: new ZipWorkspace(), existed: false };

  const zipBuf = await fs.readFile(zipPath);
  return { workspace: new ZipWorkspace(zipBuf), existed: true };
}

export async function saveWorkspaceToZipPath(workspace, zipPath) {
  const zipBuf = workspace.exportZipBuffer();
  await atomicWriteFile(zipPath, zipBuf);
  return { ok: true, bytes: zipBuf.length };
}

function runSandbox(req, { wallTimeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SANDBOX_RUNNER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { NODE_OPTIONS: "" }
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, wallTimeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: 1,
        error: `Failed to spawn sandbox_runner: ${String(err?.message || err)}`,
        stdout,
        stderr
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killed) {
        resolve({
          ok: false,
          exitCode: 124,
          error: `Sandbox timed out after ${wallTimeoutMs}ms`,
          signal,
          stdout,
          stderr
        });
        return;
      }

      let resp = null;
      try {
        resp = JSON.parse(stdout || "{}");
      } catch (err) {
        resolve({
          ok: false,
          exitCode: code ?? 1,
          error: `Failed to parse sandbox response: ${String(err?.message || err)}`,
          stdout,
          stderr
        });
        return;
      }
      resolve({
        ok: true,
        exitCode: code ?? 0,
        resp,
        stdout,
        stderr
      });
    });

    child.stdin.write(JSON.stringify(req));
    child.stdin.end();
  });
}

export function createHostToolHandlers({ workspace, zipPath }) {
  const base = createWorkspaceTools(workspace);

  /** @type {{ ok: true; bytes: number; ts: number } | null} */
  let lastPersist = null;

  const strOrUndef = (v) => (typeof v === "string" && v.length ? v : undefined);

  function sanitizeArgs(toolName, args) {
    const a = args && typeof args === "object" ? args : {};

    switch (toolName) {
      case "fs_read":
        return { path: strOrUndef(a.path), encoding: "utf8" };
      case "fs_read_lines":
        return { path: strOrUndef(a.path), startLine: a.startLine, endLine: a.endLine };
      case "fs_search":
        return {
          query: strOrUndef(a.query),
          pathPrefix: strOrUndef(a.path) ?? strOrUndef(a.pathPrefix),
          maxResults: DEFAULT_SEARCH_MAX_RESULTS,
          contextLines: DEFAULT_SEARCH_CONTEXT_LINES
        };
      case "fs_write":
        return { path: strOrUndef(a.path), content: String(a.content ?? ""), encoding: "utf8", overwrite: true };
      case "fs_list":
      case "fs_stat":
      case "fs_mkdir":
      case "fs_delete":
        return { path: strOrUndef(a.path), recursive: true };
      case "fs_patch_lines":
        return {
          path: strOrUndef(a.path),
          startLine: a.startLine,
          endLine: a.endLine,
          replacement: String(a.replacement ?? "")
        };
      default:
        return a;
    }
  }

  const MUTATING_TOOLS = new Set([
    "fs_write",
    "fs_patch_lines",
    "fs_mkdir",
    "fs_delete"
  ]);

  async function persist() {
    const res = await saveWorkspaceToZipPath(workspace, zipPath);
    lastPersist = { ...res, ts: Date.now() };
    return res;
  }

  /** @type {Record<string, (args: any) => Promise<any>>} */
  const handlers = {};

  for (const [name, fn] of Object.entries(base)) {
    handlers[name] = async (args) => {
      const result = fn(sanitizeArgs(name, args));
      if (MUTATING_TOOLS.has(name)) await persist();
      return result;
    };
  }

  handlers.js_exec = async (args) => {
    const entryPath = strOrUndef(args?.entryPath) ?? "~/main.ts";
    const argv = Array.isArray(args?.argv) ? args.argv.map(String) : [];
    const env = {};
    const timeoutMs = DEFAULT_EXEC_TIMEOUT_MS;

    const zip0 = workspace.exportZipBuffer();
    const req = {
      zipBase64: zip0.toString("base64"),
      entryPath,
      argv,
      env,
      timeoutMs
    };

    const wallTimeoutMs = Math.max(0, timeoutMs) + 250;
    const run = await runSandbox(req, { wallTimeoutMs });
    if (!run.ok) return run;

    const resp = run.resp;
    if (!resp?.ok) {
      return {
        ok: false,
        exitCode: resp?.exitCode ?? 1,
        error: resp?.error ?? "Sandbox execution failed",
        stack: resp?.stack ?? "",
        stdout: resp?.stdout ?? "",
        stderr: resp?.stderr ?? ""
      };
    }

    const zip1 = Buffer.from(resp.zipBase64 || "", "base64");
    workspace.importZip(zip1);
    await persist();

    return {
      ok: true,
      exitCode: resp.exitCode ?? 0,
      stdout: resp.stdout ?? "",
      stderr: resp.stderr ?? ""
    };
  };

  return {
    handlers,
    getLastPersist: () => lastPersist
  };
}
