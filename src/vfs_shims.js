/**
 * Virtual fs / fs.promises shims for code running inside the sandbox.
 *
 * They forward to the injected global `__vfs` (provided by the vm context),
 * which is a small object:
 *   __vfs.readFile(path, enc?) -> string|Buffer
 *   __vfs.writeFile(path, data, enc?) -> void
 *   __vfs.readdir(path) -> string[]
 *   __vfs.stat(path) -> { type, size }
 *   __vfs.mkdir(path, recursive?) -> void
 *   __vfs.deletePath(path) -> void
 *
 * IMPORTANT: These shims intentionally implement only a small subset.
 */

export function makeFsShim() {
  return `
    const __get = () => {
      if (!globalThis.__vfs) throw new Error("Missing __vfs in sandbox context");
      return globalThis.__vfs;
    };

    function __err(code, msg) {
      const e = new Error(msg || code);
      e.code = code;
      return e;
    }

    export function readFileSync(path, opts) {
      const enc = typeof opts === "string" ? opts : (opts && opts.encoding) || null;
      return __get().readFile(path, enc);
    }

    export function readFile(path, opts, cb) {
      const callback = typeof opts === "function" ? opts : cb;
      const enc = typeof opts === "string" ? opts : (opts && opts.encoding) || null;
      if (typeof callback !== "function") throw new TypeError("callback must be a function");
      try {
        const out = __get().readFile(path, enc);
        Promise.resolve().then(() => callback(null, out));
      } catch (e) {
        Promise.resolve().then(() => callback(e));
      }
    }

    export function writeFileSync(path, data, opts) {
      const enc = typeof opts === "string" ? opts : (opts && opts.encoding) || "utf8";
      return __get().writeFile(path, data, enc);
    }

    export function writeFile(path, data, opts, cb) {
      const callback = typeof opts === "function" ? opts : cb;
      const enc = typeof opts === "string" ? opts : (opts && opts.encoding) || "utf8";
      if (typeof callback !== "function") throw new TypeError("callback must be a function");
      try {
        __get().writeFile(path, data, enc);
        Promise.resolve().then(() => callback(null));
      } catch (e) {
        Promise.resolve().then(() => callback(e));
      }
    }

    export function readdirSync(path) {
      return __get().readdir(path);
    }

    export function existsSync(path) {
      try { return !!__get().stat(path); } catch { return false; }
    }

    export function statSync(path) {
      const s = __get().stat(path);
      if (!s) throw __err("ENOENT");
      return {
        isFile: () => s.type === "file",
        isDirectory: () => s.type === "dir",
        size: s.size
      };
    }

    export function mkdirSync(path, opts) {
      const recursive = !!(opts && typeof opts === "object" && opts.recursive);
      return __get().mkdir(path, recursive);
    }

    export function unlinkSync(path) {
      const s = __get().stat(path);
      if (!s) throw __err("ENOENT");
      if (s.type !== "file") throw __err("EISDIR");
      return __get().deletePath(path);
    }

    export function rmSync(path, opts) {
      const recursive = !!(opts && typeof opts === "object" && opts.recursive);
      if (recursive) throw __err("ERR_NOT_SUPPORTED", "rmSync: recursive is not supported");
      return __get().deletePath(path);
    }

    export default {
      readFileSync,
      readFile,
      writeFileSync,
      writeFile,
      readdirSync,
      existsSync,
      statSync,
      mkdirSync,
      unlinkSync,
      rmSync
    };
  `;
}

export function makeFsPromisesShim() {
  return `
    const __get = () => {
      if (!globalThis.__vfs) throw new Error("Missing __vfs in sandbox context");
      return globalThis.__vfs;
    };

    function __err(code, msg) {
      const e = new Error(msg || code);
      e.code = code;
      return e;
    }

    export async function readFile(path, opts) {
      const enc = typeof opts === "string" ? opts : (opts && opts.encoding) || null;
      return __get().readFile(path, enc);
    }

    export async function writeFile(path, data, opts) {
      const enc = typeof opts === "string" ? opts : (opts && opts.encoding) || "utf8";
      return __get().writeFile(path, data, enc);
    }

    export async function readdir(path) {
      return __get().readdir(path);
    }

    export async function stat(path) {
      const s = __get().stat(path);
      if (!s) throw __err("ENOENT");
      return {
        isFile: () => s.type === "file",
        isDirectory: () => s.type === "dir",
        size: s.size
      };
    }

    export async function mkdir(path, opts) {
      const recursive = !!(opts && typeof opts === "object" && opts.recursive);
      return __get().mkdir(path, recursive);
    }

    export async function unlink(path) {
      const s = __get().stat(path);
      if (!s) throw __err("ENOENT");
      if (s.type !== "file") throw __err("EISDIR");
      return __get().deletePath(path);
    }

    export async function rm(path, opts) {
      const recursive = !!(opts && typeof opts === "object" && opts.recursive);
      if (recursive) throw __err("ERR_NOT_SUPPORTED", "rm: recursive is not supported");
      return __get().deletePath(path);
    }

    export default { readFile, writeFile, readdir, stat, mkdir, unlink, rm };
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

    export function extname(p) {
      __assertPath(p);
      const b = basename(p);
      if (b === "/" || b.length === 0) return "";
      const idx = b.lastIndexOf(".");
      if (idx <= 0) return "";
      return b.slice(idx);
    }

    export function relative(from, to) {
      __assertPath(from);
      __assertPath(to);
      const fromRes = resolve(from);
      const toRes = resolve(to);
      if (fromRes === toRes) return "";
      const fromParts = fromRes.split("/").filter(Boolean);
      const toParts = toRes.split("/").filter(Boolean);
      let i = 0;
      while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i += 1;
      const out = [];
      for (let up = i; up < fromParts.length; up += 1) out.push("..");
      out.push(...toParts.slice(i));
      return out.join("/");
    }

    export function parse(p) {
      __assertPath(p);
      const n = normalize(p);
      if (n === "/") return { root: "/", dir: "/", base: "", ext: "", name: "" };
      const root = isAbsolute(n) ? "/" : "";
      const dir0 = dirname(n);
      const dir = dir0 === "." ? "" : dir0;
      const base = basename(n);
      const ext = extname(base);
      const name = ext ? base.slice(0, Math.max(0, base.length - ext.length)) : base;
      return { root, dir, base, ext, name };
    }

    export function format(obj) {
      if (!obj || typeof obj !== "object") throw new TypeError("obj must be an object");
      const dir = obj.dir || obj.root || "";
      const base = obj.base || ((obj.name || "") + (obj.ext || ""));
      if (!dir) return base;
      if (dir === "/") return base ? "/" + base : "/";
      return normalize(dir + "/" + base);
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
      extname,
      relative,
      parse,
      format,
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

export function makeOsShim() {
  return `
    export const EOL = "\\n";

    export function homedir() {
      return "/";
    }

    export function tmpdir() {
      return "/tmp";
    }

    export default { EOL, homedir, tmpdir };
  `;
}
