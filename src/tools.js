import { normPath, TIME_DIR } from "./path_utils.js";

function clipLine(line, maxLineLength) {
  const s = String(line ?? "").replace(/\r$/, "");
  const maxLen = Math.max(20, Number(maxLineLength) || 240);
  if (s.length <= maxLen) return s;
  return s.slice(0, Math.max(0, maxLen - 1)) + "…";
}

function hasUppercase(s) {
  return /[A-Z]/.test(s);
}

function shouldTreatAsText(bytes) {
  if (!(bytes instanceof Uint8Array)) return false;
  if (bytes.length === 0) return true;

  const sampleLen = Math.min(bytes.length, 8192);
  const sample = bytes.subarray(0, sampleLen);

  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) return false; // NUL byte is a strong binary signal
  }

  // Heuristic: decode a sample and consider it binary if it has many replacement chars.
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(sample);
  if (decoded.length < 32) return true;
  let repl = 0;
  for (let i = 0; i < decoded.length; i += 1) if (decoded.charCodeAt(i) === 0xfffd) repl += 1;
  return repl / decoded.length <= 0.05;
}

function matchesLine(line, query, { caseSensitive }) {
  if (caseSensitive) return line.indexOf(query) !== -1;
  return line.toLowerCase().indexOf(query.toLowerCase()) !== -1;
}

/**
 * LLM-style tool wrapper around a ZipWorkspace.
 * All paths are normalized and rooted at "~/" => "/".
 */
export function createWorkspaceTools(workspace) {
  function assertUserPath(p) {
    const n = normPath(p);
    if (n === TIME_DIR || n.startsWith(TIME_DIR + "/")) {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    }
    return n;
  }

  return {
    fs_read({ path, encoding = "utf8", maxBytes = 2_000_000 }) {
      const p = assertUserPath(path);
      const st = workspace.stat(p);
      if (!st || st.type !== "file") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (st.size > maxBytes) throw Object.assign(new Error("EFBIG"), { code: "EFBIG" });

      if (encoding === "base64") {
        const buf = workspace.readFile(p);
        return { path: p, encoding: "base64", content: Buffer.from(buf).toString("base64") };
      }
      const text = workspace.readFile(p, encoding);
      return { path: p, encoding, content: text };
    },

    fs_read_lines({ path, startLine = 1, endLine = 200, maxBytes = 2_000_000 }) {
      const p = assertUserPath(path);
      const st = workspace.stat(p);
      if (!st || st.type !== "file") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (st.size > maxBytes) throw Object.assign(new Error("EFBIG"), { code: "EFBIG" });

      const text = workspace.readFile(p, "utf8");
      const lines = text.split(/\r?\n/);
      const totalLines = lines.length;

      const s = Math.max(1, Number(startLine) || 1);
      const e = Math.max(s, Number(endLine) || s);
      const end = Math.min(totalLines, e);
      const slice = lines.slice(s - 1, end);

      return {
        path: p,
        startLine: s,
        endLine: end,
        totalLines,
        lines: slice.map((content, i) => ({ lineNumber: s + i, content }))
      };
    },

    /**
     * Search text files for a literal substring and return small, patch-friendly contexts.
     *
     * Designed for agent workflows: search -> fs_read_lines -> fs_patch_lines.
     */
    fs_search({
      query,
      pathPrefix = "~/",
      maxResults = 8,
      contextLines = 2,
      maxLineLength = 240,
      caseSensitive
    }) {
      const q = String(query ?? "");
      if (!q) throw new Error("query must be a non-empty string");

      const prefixPath = assertUserPath(pathPrefix);
      const prefixStat = workspace.stat(prefixPath);
      if (!prefixStat) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });

      const maxRes = Math.max(1, Math.min(50, Number(maxResults) || 8));
      const ctx = Math.max(0, Math.min(20, Number(contextLines) || 0));
      const maxLen = Math.max(20, Math.min(2000, Number(maxLineLength) || 240));

      const cs = typeof caseSensitive === "boolean" ? caseSensitive : hasUppercase(q);

      const filePaths = [];
      if (prefixStat.type === "file") {
        filePaths.push(prefixPath);
      } else {
        const dirPrefix = prefixPath === "/" ? "/" : prefixPath + "/";
        for (const p of workspace.files.keys()) {
          if (p === TIME_DIR || p.startsWith(TIME_DIR + "/")) continue;
          if (p.startsWith(dirPrefix)) filePaths.push(p);
        }
        filePaths.sort();
      }

      const results = [];
      let truncated = false;
      let scannedFiles = 0;
      let matchedFiles = 0;
      let skippedBinaryFiles = 0;

      for (const p of filePaths) {
        if (results.length >= maxRes) {
          truncated = true;
          break;
        }

        const bytes = workspace.files.get(p);
        if (!bytes) continue;

        scannedFiles += 1;
        if (!shouldTreatAsText(bytes)) {
          skippedBinaryFiles += 1;
          continue;
        }

        const pending = [];
        const beforeBuf = [];

        const decoder = new TextDecoder("utf-8", { fatal: false });
        const chunkSize = 64 * 1024;
        let carry = "";
        let lineNumber = 1;
        let fileHadMatch = false;

        const flushReady = () => {
          for (let i = pending.length - 1; i >= 0; i -= 1) {
            if (pending[i].remainingAfter === 0) {
              const done = pending[i];
              results.push({
                path: p,
                matchLine: done.matchLine,
                contextStartLine: done.lines[0]?.lineNumber ?? done.matchLine,
                contextEndLine: done.lines[done.lines.length - 1]?.lineNumber ?? done.matchLine,
                lines: done.lines
              });
              pending.splice(i, 1);
              if (results.length >= maxRes) return true;
            }
          }
          return false;
        };

        const processLine = (rawLine) => {
          const entry = { lineNumber, content: clipLine(rawLine, maxLen) };

          // Fill "after" context for already-started matches.
          for (const r of pending) {
            if (r.remainingAfter > 0) {
              r.lines.push(entry);
              r.remainingAfter -= 1;
            }
          }

          // Create a new match context if we still have capacity.
          if ((results.length + pending.length) < maxRes && matchesLine(rawLine, q, { caseSensitive: cs })) {
            fileHadMatch = true;
            const before = beforeBuf.slice(Math.max(0, beforeBuf.length - ctx));
            const lines = [...before, entry];
            pending.push({ matchLine: lineNumber, remainingAfter: ctx, lines });
          }

          // Update ring buffer for "before" context.
          if (ctx > 0) {
            beforeBuf.push(entry);
            if (beforeBuf.length > ctx) beforeBuf.shift();
          }

          lineNumber += 1;
        };

        for (let off = 0; off < bytes.length; off += chunkSize) {
          carry += decoder.decode(bytes.subarray(off, off + chunkSize), { stream: true });

          // Process complete lines.
          while (true) {
            const idx = carry.indexOf("\n");
            if (idx === -1) break;
            const line = carry.slice(0, idx);
            carry = carry.slice(idx + 1);
            processLine(line);
            if (flushReady()) return {
              query: q,
              pathPrefix: prefixPath,
              caseSensitive: cs,
              maxResults: maxRes,
              contextLines: ctx,
              results,
              truncated: true,
              scannedFiles,
              matchedFiles: matchedFiles + (fileHadMatch ? 1 : 0),
              skippedBinaryFiles
            };
          }

          // If we reached capacity, we can stop once pending contexts are filled.
          if (results.length >= maxRes) {
            truncated = true;
            break;
          }
        }

        // Flush decoder + last partial line (if any)
        carry += decoder.decode();
        if (carry.length > 0) processLine(carry);

        // Finalize any remaining pending contexts (end-of-file)
        while (pending.length > 0) {
          for (const r of pending) r.remainingAfter = 0;
          if (flushReady()) break;
        }

        if (fileHadMatch) matchedFiles += 1;
      }

      return {
        query: q,
        pathPrefix: prefixPath,
        caseSensitive: cs,
        maxResults: maxRes,
        contextLines: ctx,
        results,
        truncated,
        scannedFiles,
        matchedFiles,
        skippedBinaryFiles
      };
    },

    fs_write({ path, content, encoding = "utf8", overwrite = true }) {
      const p = assertUserPath(path);
      if (encoding === "base64") {
        const buf = Buffer.from(content, "base64");
        workspace.writeFile(p, buf, "utf8", overwrite);
      } else {
        workspace.writeFile(p, String(content), encoding, overwrite);
      }
      return { ok: true, path: p };
    },

    fs_list({ path = "~/" }) {
      const p = assertUserPath(path);
      let entries = workspace.list(p);
      if (p === "/") entries = entries.filter((e) => e !== ".time");
      return { path: p, entries };
    },

    fs_stat({ path }) {
      const p = assertUserPath(path);
      const st = workspace.stat(p);
      if (!st) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { path: p, ...st };
    },

    fs_mkdir({ path, recursive = true }) {
      const p = assertUserPath(path);
      workspace.mkdir(p, recursive);
      return { ok: true, path: p };
    },

    fs_delete({ path }) {
      const p = assertUserPath(path);
      workspace.delete(p);
      return { ok: true, path: p };
    },

    /**
     * Very simple patch tool: replace a range of lines (1-based, inclusive).
     * This avoids unified-diff parsing complexity but still enables precise edits.
     */
    fs_patch_lines({ path, startLine, endLine, replacement }) {
      const p = assertUserPath(path);
      const text = workspace.readFile(p, "utf8");
      const lines = text.split(/\r?\n/);

      const s = Math.max(1, Number(startLine));
      const e = Math.max(s, Number(endLine));
      const before = lines.slice(0, s - 1);
      const after = lines.slice(e);

      const replLines = String(replacement).split(/\r?\n/);
      const out = [...before, ...replLines, ...after].join("\n");
      workspace.writeFile(p, out, "utf8", true);
      return { ok: true, path: p };
    }
  };
}
