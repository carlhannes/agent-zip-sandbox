import path from "node:path";
const posix = path.posix;

/**
 * Normalize a user path into a POSIX absolute path rooted at "/".
 * Accepts "~/x", "/x", "x".
 */
export function normPath(p) {
  if (typeof p !== "string") throw new TypeError("path must be a string");
  p = p.replace(/\\/g, "/");
  if (p === "~") p = "~/";
  if (p.startsWith("~/")) p = p.slice(1); // "~/" -> "/"
  if (!p.startsWith("/")) p = "/" + p;
  p = posix.normalize(p);

  // Prevent escaping root via weird normalization results.
  if (!p.startsWith("/")) p = "/" + p;
  // Canonicalize: no trailing slashes except root.
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p;
}

export function dirname(p) {
  return posix.dirname(normPath(p));
}

export function basename(p) {
  return posix.basename(normPath(p));
}

export function join(...parts) {
  return posix.join(...parts.map(normPath));
}
