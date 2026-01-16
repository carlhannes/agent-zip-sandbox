import { unzipSync, zipSync } from "fflate";
import path from "node:path";
import { normPath } from "./path_utils.js";

const posix = path.posix;

/**
 * ZIP-backed virtual workspace (in-memory).
 * - files: Map<"/a/b.txt", Uint8Array>
 * - dirs: Set<"/", "/a", "/a/b">
 */
export class ZipWorkspace {
  constructor(zipBuffer = null) {
    /** @type {Map<string, Uint8Array>} */
    this.files = new Map();
    /** @type {Set<string>} */
    this.dirs = new Set(["/"]);

    if (zipBuffer) this.importZip(zipBuffer);
  }

  _ensureDir(dirPath) {
    dirPath = normPath(dirPath);
    const parts = dirPath.split("/").filter(Boolean);
    let cur = "/";
    this.dirs.add(cur);
    for (const part of parts) {
      cur = cur === "/" ? `/${part}` : `${cur}/${part}`;
      this.dirs.add(cur);
    }
  }

  importZip(zipBuffer) {
    const obj = unzipSync(new Uint8Array(zipBuffer)); // { "a/b.txt": Uint8Array, ... }
    this.files.clear();
    this.dirs = new Set(["/"]);

    for (const [name, bytes] of Object.entries(obj)) {
      const p = normPath("/" + name);
      const d = posix.dirname(p);
      this._ensureDir(d);
      this.files.set(p, bytes);
    }
  }

  exportZipBuffer() {
    /** @type {Record<string, Uint8Array>} */
    const out = {};
    for (const [p, bytes] of this.files.entries()) {
      const rel = p.startsWith("/") ? p.slice(1) : p;
      out[rel] = bytes;
    }
    const zipped = zipSync(out, { level: 6 });
    return Buffer.from(zipped);
  }

  stat(p) {
    p = normPath(p);
    if (this.files.has(p)) {
      return { type: "file", size: this.files.get(p).length };
    }
    if (this.dirs.has(p)) {
      return { type: "dir", size: 0 };
    }
    return null;
  }

  list(p = "/") {
    p = normPath(p);
    if (!this.dirs.has(p)) {
      throw Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" });
    }
    const children = new Set();

    for (const d of this.dirs) {
      if (d === "/") continue;
      if (posix.dirname(d) === p) children.add(posix.basename(d));
    }
    for (const f of this.files.keys()) {
      if (posix.dirname(f) === p) children.add(posix.basename(f));
    }
    return Array.from(children).sort();
  }

  readFile(p, encoding = null) {
    p = normPath(p);
    const bytes = this.files.get(p);
    if (!bytes) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const buf = Buffer.from(bytes);
    return encoding ? buf.toString(encoding) : buf;
  }

  writeFile(p, data, encoding = "utf8", overwrite = true) {
    p = normPath(p);
    const dir = posix.dirname(p);
    this._ensureDir(dir);

    if (!overwrite && this.files.has(p)) {
      throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    }

    const buf = Buffer.isBuffer(data)
      ? data
      : typeof data === "string"
        ? Buffer.from(data, encoding)
        : Buffer.from(data);

    this.files.set(p, new Uint8Array(buf));
  }

  mkdir(p, recursive = true) {
    p = normPath(p);
    if (!recursive) {
      const parent = posix.dirname(p);
      if (!this.dirs.has(parent)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      this.dirs.add(p);
      return;
    }
    this._ensureDir(p);
  }

  delete(p) {
    p = normPath(p);
    if (this.files.delete(p)) return;

    if (this.dirs.has(p)) {
      if (p === "/") throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      // simple: refuse to delete non-empty dirs
      for (const f of this.files.keys()) if (f.startsWith(p + "/")) throw Object.assign(new Error("ENOTEMPTY"), { code: "ENOTEMPTY" });
      for (const d of this.dirs) if (d !== p && d.startsWith(p + "/")) throw Object.assign(new Error("ENOTEMPTY"), { code: "ENOTEMPTY" });
      this.dirs.delete(p);
      return;
    }
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }
}
