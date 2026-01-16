import esbuild from "esbuild";
import { ZipWorkspace } from "./workspace.js";
import { normPath } from "./path_utils.js";
import { workspaceResolverPlugin, blockNonRelativeImportsPlugin } from "./esbuild_plugins.js";
import { runBundledCjs } from "./vm_runner.js";

// --- Helpers ---
function readAllStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function makeVfs(workspace) {
  return {
    readFile: (p, enc = null) => workspace.readFile(p, enc),
    writeFile: (p, data, enc = "utf8") => workspace.writeFile(p, data, enc, true),
    readdir: (p) => workspace.list(p),
    stat: (p) => workspace.stat(p),
    mkdir: (p, recursive = false) => workspace.mkdir(p, recursive),
    deletePath: (p) => workspace.delete(p)
  };
}

async function main() {
  try {
    const raw = await readAllStdin();
    const req = JSON.parse(raw || "{}");

    const zipBase64 = req.zipBase64 || "";
    const entryPath = req.entryPath || "~/main.ts";
    const argv = Array.isArray(req.argv) ? req.argv : [];
    const env = req.env && typeof req.env === "object" ? req.env : {};
    const timeoutMs = Number.isFinite(req.timeoutMs) ? req.timeoutMs : 1500;

    const zipBuf = zipBase64 ? Buffer.from(zipBase64, "base64") : Buffer.from([]);
    const ws = new ZipWorkspace(zipBuf.length ? zipBuf : null);

    // Build (bundle) from workspace
    const entryNorm = normPath(entryPath);
    const buildResult = await esbuild.build({
      entryPoints: ["__entry__"], // intercepted by workspaceResolverPlugin
      bundle: true,
      write: false,
      platform: "node",
      format: "cjs",
      target: ["node20"],
      plugins: [
        workspaceResolverPlugin(ws, entryNorm),
        blockNonRelativeImportsPlugin()
      ],
      logLevel: "silent"
    });

    const outFile = buildResult.outputFiles?.[0];
    if (!outFile) throw new Error("esbuild produced no output");
    const bundled = outFile.text;

    // Run in vm
    const vfs = makeVfs(ws);
    const run = runBundledCjs({
      code: bundled,
      filename: "bundle.cjs",
      vfs,
      argv,
      env,
      timeoutMs
    });

    const outZip = ws.exportZipBuffer();
    const resp = {
      ok: true,
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: 0,
      zipBase64: outZip.toString("base64")
    };
    process.stdout.write(JSON.stringify(resp));
  } catch (err) {
    const resp = {
      ok: false,
      error: String(err?.message || err),
      stack: err?.stack || "",
      exitCode: 1
    };
    process.stdout.write(JSON.stringify(resp));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
