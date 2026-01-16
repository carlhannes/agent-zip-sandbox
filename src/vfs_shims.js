/**
 * Virtual fs / fs.promises shims for code running inside the sandbox.
 *
 * They forward to the injected global `__vfs` (provided by the vm context),
 * which is a small object:
 *   __vfs.readFile(path, enc?) -> string|Buffer
 *   __vfs.writeFile(path, data, enc?) -> void
 *   __vfs.readdir(path) -> string[]
 *   __vfs.stat(path) -> { type, size }
 *
 * IMPORTANT: These shims intentionally implement only a small subset.
 */

export function makeFsShim() {
  return `
    const __get = () => {
      if (!globalThis.__vfs) throw new Error("Missing __vfs in sandbox context");
      return globalThis.__vfs;
    };

    export function readFileSync(path, opts) {
      const enc = typeof opts === "string" ? opts : (opts && opts.encoding) || null;
      return __get().readFile(path, enc);
    }

    export function writeFileSync(path, data, opts) {
      const enc = typeof opts === "string" ? opts : (opts && opts.encoding) || "utf8";
      return __get().writeFile(path, data, enc);
    }

    export function readdirSync(path) {
      return __get().readdir(path);
    }

    export function existsSync(path) {
      try { return !!__get().stat(path); } catch { return false; }
    }

    export function statSync(path) {
      const s = __get().stat(path);
      if (!s) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
      return {
        isFile: () => s.type === "file",
        isDirectory: () => s.type === "dir",
        size: s.size
      };
    }

    export default { readFileSync, writeFileSync, readdirSync, existsSync, statSync };
  `;
}

export function makeFsPromisesShim() {
  return `
    const __get = () => {
      if (!globalThis.__vfs) throw new Error("Missing __vfs in sandbox context");
      return globalThis.__vfs;
    };

    export async function readFile(path, opts) {
      const enc = typeof opts === "string" ? opts : (opts && opts.encoding) || null;
      return __get().readFile(path, enc);
    }

    export async function writeFile(path, data, opts) {
      const enc = typeof opts === "string" ? opts : (opts && opts.encoding) || "utf8";
      return __get().writeFile(path, data, enc);
    }

    export default { readFile, writeFile };
  `;
}

export function makePathPosixShim() {
  return `
    function __assertPath(p) {
      if (typeof p !== "string") throw new TypeError("path must be a string");
    }

    export function normalize(p) {
      __assertPath(p);
      if (p.length === 0) return ".";
      const isAbsolute = p.startsWith("/");
      const trailingSlash = p.endsWith("/");
      const parts = p.split("/").filter(Boolean);
      const out = [];
      for (const part of parts) {
        if (part === ".") continue;
        if (part === "..") {
          if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
          else if (!isAbsolute) out.push("..");
          continue;
        }
        out.push(part);
      }
      let result = (isAbsolute ? "/" : "") + out.join("/");
      if (result.length === 0) result = isAbsolute ? "/" : ".";
      if (trailingSlash && result !== "/") result += "/";
      return result;
    }

    export function join(...parts) {
      if (parts.length === 0) return ".";
      let joined = "";
      for (const part of parts) {
        __assertPath(part);
        if (part.length === 0) continue;
        if (joined.length === 0) joined = part;
        else joined = joined + "/" + part;
      }
      if (joined.length === 0) return ".";
      return normalize(joined);
    }

    export function resolve(...parts) {
      let resolved = "";
      let absolute = false;
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        const part = parts[i];
        __assertPath(part);
        if (part.length === 0) continue;
        resolved = part + (resolved.length ? "/" + resolved : "");
        if (part.startsWith("/")) {
          absolute = true;
          break;
        }
      }
      if (!absolute) resolved = "/" + resolved;
      return normalize(resolved);
    }

    export function dirname(p) {
      __assertPath(p);
      if (p.length === 0) return ".";
      const n = normalize(p);
      if (n === "/") return "/";
      const withoutTrailing = n.endsWith("/") ? n.slice(0, -1) : n;
      const idx = withoutTrailing.lastIndexOf("/");
      if (idx === -1) return ".";
      if (idx === 0) return "/";
      return withoutTrailing.slice(0, idx);
    }

    export function basename(p) {
      __assertPath(p);
      if (p.length === 0) return "";
      const n = normalize(p);
      if (n === "/") return "/";
      const withoutTrailing = n.endsWith("/") ? n.slice(0, -1) : n;
      const idx = withoutTrailing.lastIndexOf("/");
      return idx === -1 ? withoutTrailing : withoutTrailing.slice(idx + 1);
    }

    export function isAbsolute(p) {
      __assertPath(p);
      return p.startsWith("/");
    }

    const posix = {
      sep: "/",
      delimiter: ":",
      normalize,
      join,
      resolve,
      dirname,
      basename,
      isAbsolute
    };

    export { posix };

    export default {
      ...posix,
      posix,
      // We intentionally only support POSIX paths in the sandbox.
      win32: posix
    };
  `;
}
