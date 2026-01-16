import vm from "node:vm";

/**
 * Run bundled CJS code in a constrained vm context.
 * - Provide a blocked require stub (no host modules)
 * - Provide __vfs (workspace-backed fs)
 * - Capture console output
 * - Enforce a synchronous timeout (vm option) + outer wall-clock kill switch (caller responsibility)
 */
export function runBundledCjs({
  code,
  filename = "bundle.cjs",
  vfs,
  argv = [],
  env = {},
  timeoutMs = 1500
}) {
  const logs = [];
  const errs = [];

  const safeConsole = {
    log: (...a) => logs.push(a.map(String).join(" ")),
    info: (...a) => logs.push(a.map(String).join(" ")),
    warn: (...a) => errs.push(a.map(String).join(" ")),
    error: (...a) => errs.push(a.map(String).join(" "))
  };

  function safeRequire(spec) {
    const e = new Error(`Blocked require: ${spec}. This sandbox does not load host modules at runtime.`);
    e.code = "MODULE_NOT_FOUND";
    throw e;
  }

  const sandbox = {
    console: safeConsole,
    __vfs: vfs,
    // minimal process stub
    process: Object.freeze({
      argv: ["node", filename, ...argv],
      env: Object.freeze({ ...env }),
      cwd: () => "/",
      platform: "linux",
      versions: {}
    }),
    Buffer,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };

  // Hardening: disable eval/new Function inside this context (best effort).
  const context = vm.createContext(sandbox, {
    name: "agent-sandbox",
    codeGeneration: { strings: false, wasm: false }
  });

  const module = { exports: {} };
  const exports = module.exports;

  // Wrap like Node does for CJS.
  const wrapped = `(function (require, module, exports) { "use strict";\n${code}\n})`;

  const script = new vm.Script(wrapped, { filename });
  const fn = script.runInContext(context, { timeout: timeoutMs });

  // Execute
  fn(safeRequire, module, exports);

  return {
    stdout: logs.join("\n"),
    stderr: errs.join("\n"),
    exports: module.exports
  };
}
