import path from "node:path";
import { normPath } from "./path_utils.js";
import { makeFsShim, makeFsPromisesShim, makePathPosixShim, makeOsShim } from "./vfs_shims.js";

const posix = path.posix;

// A conservative denylist of modules we never want reachable.
const DENY = new Set([
  "child_process", "node:child_process",
  "worker_threads", "node:worker_threads",
  "vm", "node:vm",
  "net", "node:net",
  "tls", "node:tls",
  "http", "node:http",
  "https", "node:https",
  "dgram", "node:dgram",
  "cluster", "node:cluster",
  "inspector", "node:inspector",
  "fs", "node:fs", "fs/promises", "node:fs/promises", // handled separately by shim
  "module", "node:module"
]);

/**
 * esbuild plugin: load workspace files from ZipWorkspace in-memory.
 * Supports relative imports inside the workspace.
 */
export function workspaceResolverPlugin(workspace, entryPath) {
  return {
    name: "workspace-resolver",
    setup(build) {
      // Entry point resolution
      build.onResolve({ filter: /.*/ }, (args) => {
        // Only handle the entry explicitly via args.kind === 'entry-point'
        if (args.kind === "entry-point") {
          return { path: normPath(entryPath), namespace: "zip" };
        }

        const spec = args.path;

        // Shim builtins handled elsewhere
        if (
          spec === "fs" ||
          spec === "node:fs" ||
          spec === "fs/promises" ||
          spec === "node:fs/promises" ||
          spec === "os" ||
          spec === "node:os" ||
          spec === "path" ||
          spec === "node:path"
        ) {
          return { path: spec, namespace: "shim" };
        }

        // Block denylist
        if (DENY.has(spec)) {
          return { errors: [{ text: `Blocked import: ${spec}` }] };
        }

        // Relative or absolute workspace paths:
        const isRel = spec.startsWith("./") || spec.startsWith("../");
        const isAbs = spec.startsWith("/") || spec.startsWith("~/");

        if (isRel || isAbs) {
          const importer = args.importer ? normPath(args.importer) : normPath(entryPath);
          const baseDir = posix.dirname(importer);

          const candidateBase = isAbs ? normPath(spec) : normPath(posix.join(baseDir, spec));

          const candidates = [
            candidateBase,
            candidateBase + ".ts",
            candidateBase + ".tsx",
            candidateBase + ".js",
            candidateBase + ".mjs",
            candidateBase + ".cjs",
            candidateBase + ".json",
            posix.join(candidateBase, "index.ts"),
            posix.join(candidateBase, "index.tsx"),
            posix.join(candidateBase, "index.js"),
            posix.join(candidateBase, "index.mjs"),
            posix.join(candidateBase, "index.cjs"),
            posix.join(candidateBase, "index.json")
          ];

          for (const p of candidates) {
            const st = workspace.stat(p);
            if (st?.type === "file") return { path: p, namespace: "zip" };
          }
          return { errors: [{ text: `Workspace module not found: ${spec} (from ${args.importer})` }] };
        }

        // Non-relative import: blocked by blockNonRelativeImportsPlugin (unless provided as a shim above).
        return null;
      });

      build.onLoad({ filter: /.*/, namespace: "zip" }, (args) => {
        const p = normPath(args.path);
        const buf = workspace.readFile(p);

        let loader = "js";
        if (p.endsWith(".ts")) loader = "ts";
        else if (p.endsWith(".tsx")) loader = "tsx";
        else if (p.endsWith(".jsx")) loader = "jsx";
        else if (p.endsWith(".json")) loader = "json";
        else if (p.endsWith(".mjs")) loader = "js";
        else if (p.endsWith(".cjs")) loader = "js";

        return { contents: Buffer.from(buf).toString("utf8"), loader, resolveDir: posix.dirname(p) };
      });

      // Provide shim module sources
      build.onLoad({ filter: /.*/, namespace: "shim" }, (args) => {
        if (args.path === "fs" || args.path === "node:fs") {
          return { contents: makeFsShim(), loader: "js" };
        }
        if (args.path === "fs/promises" || args.path === "node:fs/promises") {
          return { contents: makeFsPromisesShim(), loader: "js" };
        }
        if (args.path === "os" || args.path === "node:os") {
          return { contents: makeOsShim(), loader: "js" };
        }
        if (args.path === "path" || args.path === "node:path") {
          return { contents: makePathPosixShim(), loader: "js" };
        }
        return { errors: [{ text: `Unknown shim: ${args.path}` }] };
      });
    }
  };
}

/**
 * esbuild plugin: block all non-relative imports (everything must be bundled or shimmed).
 *
 * Note: This repo intentionally avoids loading any host Node builtins at runtime. If you need something,
 * add a shim module in `workspaceResolverPlugin`.
 */
export function blockNonRelativeImportsPlugin() {
  return {
    name: "block-non-relative-imports",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const spec = args.path;

        // already handled via workspaceResolverPlugin for relative/abs and for shims.
        const isRel = spec.startsWith("./") || spec.startsWith("../");
        const isAbs = spec.startsWith("/") || spec.startsWith("~/");
        const isShim =
          spec === "fs" ||
          spec === "node:fs" ||
          spec === "fs/promises" ||
          spec === "node:fs/promises" ||
          spec === "os" ||
          spec === "node:os" ||
          spec === "path" ||
          spec === "node:path";
        if (isRel || isAbs || isShim) return null;

        // denylist check (defense-in-depth)
        if (DENY.has(spec)) return { errors: [{ text: `Blocked import: ${spec}` }] };

        return { errors: [{ text: `Blocked non-relative import: ${spec}. Only workspace paths and shims are allowed.` }] };
      });
    }
  };
}
