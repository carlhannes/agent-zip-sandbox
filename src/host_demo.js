import { spawn } from "node:child_process";
import { ZipWorkspace } from "./workspace.js";
import { createWorkspaceTools } from "./tools.js";

// Demo: create workspace, write a TS file, execute it in sandbox, read results.
function runSandbox(req) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/sandbox_runner.js"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, NODE_OPTIONS: "" }
    });

    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        const resp = JSON.parse(out || "{}");
        resolve({ code, resp });
      } catch (e) {
        reject(new Error(`Failed to parse sandbox response: ${e}\nRaw:\n${out}`));
      }
    });

    child.stdin.write(JSON.stringify(req));
    child.stdin.end();
  });
}

async function main() {
  const ws = new ZipWorkspace();
  const tools = createWorkspaceTools(ws);

  // Write a small TS program that writes a file to the workspace using fs shim.
  tools.fs_write({
    path: "~/main.ts",
    content: `
      import fs from "fs";
      import path from "path";

      const outPath = "~/out/hello.txt";
      fs.writeFileSync(outPath, "Hello from inside the ZIP workspace!\\n");
      fs.writeFileSync("~/out/where.txt", "cwd is virtual; writing under ~/ works.\\n");

      // show that the POSIX path shim can be used inside the sandbox
      fs.writeFileSync("~/out/path.txt", "join:" + path.join("a", "b") + "\\n");

      console.log("Wrote:", outPath);
    `,
    encoding: "utf8"
  });

  tools.fs_mkdir({ path: "~/out", recursive: true });

  const zip0 = ws.exportZipBuffer();
  const req = {
    zipBase64: zip0.toString("base64"),
    entryPath: "~/main.ts",
    argv: ["--demo"],
    env: { DEMO: "1" },
    timeoutMs: 1500
  };

  const { resp } = await runSandbox(req);

  if (!resp.ok) {
    console.error("Sandbox error:", resp.error);
    console.error(resp.stack);
    process.exit(1);
  }

  console.log("=== SANDBOX STDOUT ===");
  console.log(resp.stdout || "(empty)");
  console.log("=== SANDBOX STDERR ===");
  console.log(resp.stderr || "(empty)");

  const zip1 = Buffer.from(resp.zipBase64, "base64");
  const ws2 = new ZipWorkspace(zip1);

  console.log("=== WORKSPACE LIST /out ===");
  console.log(ws2.list("~/out"));

  console.log("=== out/hello.txt ===");
  console.log(ws2.readFile("~/out/hello.txt", "utf8"));

  console.log("ZIP size (bytes):", zip1.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
