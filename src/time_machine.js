import path from "node:path";
import { normPath, isTimePath, TIME_DIR } from "./path_utils.js";

export { TIME_DIR };

const posix = path.posix;
export const DEFAULT_RETENTION = Object.freeze({
  keepRecent: 50,
  maxEntries: 200,
  mergeGroup: 5
});

function nowIso() {
  return new Date().toISOString();
}

function joinPosix(a, b) {
  if (!a) return b;
  if (!b) return a;
  return posix.join(a, b);
}

function ensureDir(workspace, dirPath) {
  workspace.mkdir(dirPath, true);
}

function writeJson(workspace, p, obj) {
  ensureDir(workspace, posix.dirname(p));
  workspace.writeFile(p, JSON.stringify(obj, null, 2) + "\n", "utf8", true);
}

function readJson(workspace, p) {
  const txt = workspace.readFile(p, "utf8");
  return JSON.parse(txt);
}

function bytesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function shouldTreatAsText(bytes) {
  if (!(bytes instanceof Uint8Array)) return false;
  if (bytes.length === 0) return true;
  const sampleLen = Math.min(bytes.length, 8192);
  const sample = bytes.subarray(0, sampleLen);
  for (let i = 0; i < sample.length; i += 1) if (sample[i] === 0) return false;
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(sample);
  if (decoded.length < 32) return true;
  let repl = 0;
  for (let i = 0; i < decoded.length; i += 1) if (decoded.charCodeAt(i) === 0xfffd) repl += 1;
  return repl / decoded.length <= 0.05;
}

function deleteTree(workspace, p) {
  const st = workspace.stat(p);
  if (!st) return;
  if (st.type === "file") {
    workspace.delete(p);
    return;
  }
  const children = workspace.list(p);
  for (const name of children) deleteTree(workspace, joinPosix(p, name));
  workspace.delete(p);
}

function safeId() {
  const ts = nowIso().replace(/[:.]/g, "-");
  const rand = Math.random().toString(16).slice(2, 8);
  return `${ts}_${rand}`;
}

function statePath() {
  return joinPosix(TIME_DIR, "state.json");
}

function entryPath(id) {
  return joinPosix(joinPosix(TIME_DIR, "entries"), `${id}.json`);
}

function blobPath(id, which, absPath) {
  const p = normPath(absPath);
  const rel = p.startsWith("/") ? p.slice(1) : p;
  return joinPosix(joinPosix(joinPosix(TIME_DIR, "blobs"), joinPosix(id, which)), rel);
}

function loadState(workspace) {
  const p = statePath();
  const st = workspace.stat(p);
  if (!st) {
    const createdAt = nowIso();
    const state = {
      version: 1,
      createdAt,
      updatedAt: createdAt,
      cursor: 0,
      retention: { ...DEFAULT_RETENTION },
      entries: []
    };
    writeJson(workspace, p, state);
    return state;
  }
  const state = readJson(workspace, p);
  const merged = {
    version: 1,
    createdAt: state.createdAt || nowIso(),
    updatedAt: state.updatedAt || nowIso(),
    cursor: Number.isFinite(state.cursor) ? state.cursor : 0,
    retention: { ...DEFAULT_RETENTION, ...(state.retention || {}) },
    entries: Array.isArray(state.entries) ? state.entries : []
  };
  // Clamp cursor.
  merged.cursor = Math.max(0, Math.min(merged.entries.length, merged.cursor));
  return merged;
}

function saveState(workspace, state) {
  state.updatedAt = nowIso();
  writeJson(workspace, statePath(), state);
}

function loadEntry(workspace, id) {
  return readJson(workspace, entryPath(id));
}

function summarizeOp(change) {
  if (change.kind === "dir") {
    if (!change.beforeExists && change.afterExists) return "dir+";
    if (change.beforeExists && !change.afterExists) return "dir-";
    return "dir~";
  }
  if (!change.beforeExists && change.afterExists) return "file+";
  if (change.beforeExists && !change.afterExists) return "file-";
  return "file~";
}

function computeDirChanges(beforeDirs, afterDirs) {
  const before = new Set(beforeDirs || []);
  const after = new Set(afterDirs || []);
  const out = [];
  for (const d of before) {
    if (d === "/") continue;
    if (isTimePath(d)) continue;
    if (!after.has(d)) out.push({ kind: "dir", path: d, beforeExists: true, afterExists: false });
  }
  for (const d of after) {
    if (d === "/") continue;
    if (isTimePath(d)) continue;
    if (!before.has(d)) out.push({ kind: "dir", path: d, beforeExists: false, afterExists: true });
  }
  return out;
}

function computeFileChanges(beforeFiles, afterFiles, id) {
  const out = [];
  const keys = new Set([...(beforeFiles?.keys?.() || []), ...(afterFiles?.keys?.() || [])]);
  for (const pRaw of keys) {
    const p = normPath(pRaw);
    if (isTimePath(p)) continue;
    const a = beforeFiles?.get?.(p);
    const b = afterFiles?.get?.(p);
    const beforeExists = a instanceof Uint8Array;
    const afterExists = b instanceof Uint8Array;
    if (!beforeExists && !afterExists) continue;
    if (beforeExists && afterExists && bytesEqual(a, b)) continue;

    /** @type {any} */
    const ch = { kind: "file", path: p, beforeExists, afterExists };
    if (beforeExists) {
      ch.beforeBlob = blobPath(id, "before", p);
      ch.beforeSize = a.length;
    }
    if (afterExists) {
      ch.afterBlob = blobPath(id, "after", p);
      ch.afterSize = b.length;
    }
    out.push(ch);
  }
  out.sort((x, y) => x.path.localeCompare(y.path));
  return out;
}

function writeBlobs(workspace, id, changes, beforeFiles, afterFiles) {
  for (const ch of changes) {
    if (ch.kind !== "file") continue;
    if (ch.beforeExists && ch.beforeBlob) {
      const bytes = beforeFiles.get(ch.path);
      ensureDir(workspace, posix.dirname(ch.beforeBlob));
      workspace.writeFile(ch.beforeBlob, Buffer.from(bytes), "utf8", true);
    }
    if (ch.afterExists && ch.afterBlob) {
      const bytes = afterFiles.get(ch.path);
      ensureDir(workspace, posix.dirname(ch.afterBlob));
      workspace.writeFile(ch.afterBlob, Buffer.from(bytes), "utf8", true);
    }
  }
}

function deleteEntry(workspace, id) {
  // Entry JSON
  const ep = entryPath(id);
  if (workspace.stat(ep)) workspace.delete(ep);
  // Blobs dir
  const bp = joinPosix(joinPosix(TIME_DIR, "blobs"), id);
  deleteTree(workspace, bp);
}

function compactIfNeeded(workspace, state) {
  const keepRecent = Math.max(0, Number(state.retention?.keepRecent) || DEFAULT_RETENTION.keepRecent);
  const maxEntries = Math.max(1, Number(state.retention?.maxEntries) || DEFAULT_RETENTION.maxEntries);
  const mergeGroup = Math.max(2, Number(state.retention?.mergeGroup) || DEFAULT_RETENTION.mergeGroup);

  while (state.entries.length > maxEntries) {
    const mergeable = state.entries.length - keepRecent;
    if (mergeable < 2) break;
    const groupSize = Math.min(mergeGroup, mergeable);
    if (groupSize < 2) break;

    const group = state.entries.slice(0, groupSize);
    const groupIds = group.map((e) => e.id);
    const newest = group[group.length - 1];

    /** @type {Map<string, any>} */
    const files = new Map();
    /** @type {Map<string, any>} */
    const dirs = new Map();

    for (const id of groupIds) {
      const entry = loadEntry(workspace, id);
      for (const ch of entry.changes || []) {
        if (!ch || typeof ch.path !== "string") continue;
        const p = normPath(ch.path);
        if (isTimePath(p)) continue;
        if (ch.kind === "file") {
          const existing = files.get(p);
          if (!existing) {
            files.set(p, {
              kind: "file",
              path: p,
              beforeExists: !!ch.beforeExists,
              beforeBlob: ch.beforeBlob,
              beforeSize: ch.beforeSize,
              afterExists: !!ch.afterExists,
              afterBlob: ch.afterBlob,
              afterSize: ch.afterSize
            });
          } else {
            existing.afterExists = !!ch.afterExists;
            existing.afterBlob = ch.afterBlob;
            existing.afterSize = ch.afterSize;
          }
        } else if (ch.kind === "dir") {
          const existing = dirs.get(p);
          if (!existing) {
            dirs.set(p, { kind: "dir", path: p, beforeExists: !!ch.beforeExists, afterExists: !!ch.afterExists });
          } else {
            existing.afterExists = !!ch.afterExists;
          }
        }
      }
    }

    const mergedId = safeId();
    const mergedChanges = [];

    // Materialize merged changes, dropping no-ops.
    for (const ch of files.values()) {
      if (ch.beforeExists === ch.afterExists) {
        if (!ch.beforeExists) continue;
        const beforeBytes = Buffer.from(workspace.readFile(ch.beforeBlob));
        const afterBytes = Buffer.from(workspace.readFile(ch.afterBlob));
        if (bytesEqual(beforeBytes, afterBytes)) continue;
      }
      const out = { ...ch };
      if (out.beforeExists) {
        out.beforeBlob = blobPath(mergedId, "before", out.path);
      } else {
        delete out.beforeBlob;
      }
      if (out.afterExists) {
        out.afterBlob = blobPath(mergedId, "after", out.path);
      } else {
        delete out.afterBlob;
      }
      mergedChanges.push(out);
    }
    for (const ch of dirs.values()) {
      if (ch.beforeExists === ch.afterExists) continue;
      mergedChanges.push(ch);
    }

    // Write merged blobs by copying from old blobs.
    for (const ch of mergedChanges) {
      if (ch.kind !== "file") continue;
      if (ch.beforeExists) {
        const src = files.get(ch.path)?.beforeBlob;
        if (src) {
          const bytes = Buffer.from(workspace.readFile(src));
          ensureDir(workspace, posix.dirname(ch.beforeBlob));
          workspace.writeFile(ch.beforeBlob, bytes, "utf8", true);
        }
      }
      if (ch.afterExists) {
        const src = files.get(ch.path)?.afterBlob;
        if (src) {
          const bytes = Buffer.from(workspace.readFile(src));
          ensureDir(workspace, posix.dirname(ch.afterBlob));
          workspace.writeFile(ch.afterBlob, bytes, "utf8", true);
        }
      }
    }

    const mergedEntry = {
      id: mergedId,
      createdAt: newest.createdAt || nowIso(),
      tool: newest.tool || "compacted",
      compactedFrom: groupIds,
      changes: mergedChanges
    };
    writeJson(workspace, entryPath(mergedId), mergedEntry);

    // Replace in state.
    const mergedSummary = {
      id: mergedId,
      createdAt: mergedEntry.createdAt,
      tool: mergedEntry.tool,
      compacted: true,
      changedPaths: mergedChanges.length
    };
    state.entries = [mergedSummary, ...state.entries.slice(groupSize)];

    // Cursor is at the end when we compact, but keep it safe.
    state.cursor = Math.max(0, Math.min(state.entries.length, state.cursor - (groupSize - 1)));

    // Delete old entries.
    for (const id of groupIds) deleteEntry(workspace, id);
  }
}

function applyEntry(workspace, entry, which) {
  const changes = Array.isArray(entry.changes) ? entry.changes : [];
  const files = changes.filter((c) => c?.kind === "file");
  const dirs = changes.filter((c) => c?.kind === "dir");

  for (const ch of files) {
    const p = normPath(ch.path);
    if (isTimePath(p)) continue;
    const targetExists = which === "before" ? !!ch.beforeExists : !!ch.afterExists;
    if (targetExists) {
      const blob = which === "before" ? ch.beforeBlob : ch.afterBlob;
      if (!blob) continue;
      const bytes = Buffer.from(workspace.readFile(blob));
      workspace.writeFile(p, bytes, "utf8", true);
    } else {
      const st = workspace.stat(p);
      if (st && st.type === "file") workspace.delete(p);
    }
  }

  const toCreate = [];
  const toDelete = [];
  for (const ch of dirs) {
    const p = normPath(ch.path);
    if (isTimePath(p)) continue;
    const targetExists = which === "before" ? !!ch.beforeExists : !!ch.afterExists;
    if (targetExists) toCreate.push(p);
    else toDelete.push(p);
  }

  toCreate.sort((a, b) => a.length - b.length);
  for (const p of toCreate) {
    const st = workspace.stat(p);
    if (!st) workspace.mkdir(p, true);
  }

  toDelete.sort((a, b) => b.length - a.length);
  for (const p of toDelete) {
    const st = workspace.stat(p);
    if (st && st.type === "dir") {
      try {
        workspace.delete(p);
      } catch {
        // best-effort: ignore non-empty in case other changes keep it alive
      }
    }
  }
}

export function timeInit(workspace) {
  ensureDir(workspace, TIME_DIR);
  ensureDir(workspace, joinPosix(TIME_DIR, "entries"));
  ensureDir(workspace, joinPosix(TIME_DIR, "blobs"));
  loadState(workspace);
  return { ok: true };
}

/**
 * Record a history entry from before/after snapshots.
 *
 * `beforeFiles`/`afterFiles` can be partial Maps containing only relevant file paths.
 * `beforeDirs`/`afterDirs` should be full dir Sets for accurate mkdir/delete tracking.
 */
export function timeRecord(workspace, { tool, note, beforeFiles, afterFiles, beforeDirs, afterDirs, createdAt }) {
  timeInit(workspace);
  const state = loadState(workspace);

  // If we are not at the head, drop redo history.
  if (state.cursor < state.entries.length) {
    const redo = state.entries.slice(state.cursor);
    for (const e of redo) deleteEntry(workspace, e.id);
    state.entries = state.entries.slice(0, state.cursor);
  }

  const id = safeId();
  const fileChanges = computeFileChanges(beforeFiles || new Map(), afterFiles || new Map(), id);
  const dirChanges = computeDirChanges(beforeDirs || new Set(), afterDirs || new Set());
  const changes = [...fileChanges, ...dirChanges];
  if (changes.length === 0) return { ok: true, recorded: false };

  // Persist blobs for file changes.
  writeBlobs(workspace, id, fileChanges, beforeFiles || new Map(), afterFiles || new Map());

  const entry = {
    id,
    createdAt: createdAt || nowIso(),
    tool: String(tool || "unknown"),
    note: note ? String(note) : "",
    changes
  };
  writeJson(workspace, entryPath(id), entry);

  state.entries.push({
    id,
    createdAt: entry.createdAt,
    tool: entry.tool,
    compacted: false,
    changedPaths: changes.length
  });
  state.cursor = state.entries.length;

  compactIfNeeded(workspace, state);
  saveState(workspace, state);

  return { ok: true, recorded: true, id };
}

export function timeList(workspace, { limit = 50 } = {}) {
  timeInit(workspace);
  const state = loadState(workspace);
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  const total = state.entries.length;
  const start = Math.max(0, total - lim);
  return {
    ok: true,
    cursor: state.cursor,
    total,
    entries: state.entries.slice(start)
  };
}

export function timeUndo(workspace, { steps = 1 } = {}) {
  timeInit(workspace);
  const state = loadState(workspace);
  const n = Math.max(1, Math.min(1000, Number(steps) || 1));
  let did = 0;
  while (did < n && state.cursor > 0) {
    const idx = state.cursor - 1;
    const summary = state.entries[idx];
    const entry = loadEntry(workspace, summary.id);
    applyEntry(workspace, entry, "before");
    state.cursor -= 1;
    did += 1;
  }
  saveState(workspace, state);
  return { ok: true, cursor: state.cursor, did };
}

export function timeRedo(workspace, { steps = 1 } = {}) {
  timeInit(workspace);
  const state = loadState(workspace);
  const n = Math.max(1, Math.min(1000, Number(steps) || 1));
  let did = 0;
  while (did < n && state.cursor < state.entries.length) {
    const summary = state.entries[state.cursor];
    const entry = loadEntry(workspace, summary.id);
    applyEntry(workspace, entry, "after");
    state.cursor += 1;
    did += 1;
  }
  saveState(workspace, state);
  return { ok: true, cursor: state.cursor, did };
}

export function timeRestore(workspace, { id }) {
  timeInit(workspace);
  const state = loadState(workspace);
  const target = String(id || "");
  const idx = state.entries.findIndex((e) => e.id === target);
  if (idx === -1) return { ok: false, error: `Unknown history id: ${target}` };

  while (state.cursor > idx + 1) {
    const summary = state.entries[state.cursor - 1];
    const entry = loadEntry(workspace, summary.id);
    applyEntry(workspace, entry, "before");
    state.cursor -= 1;
  }
  while (state.cursor < idx + 1) {
    const summary = state.entries[state.cursor];
    const entry = loadEntry(workspace, summary.id);
    applyEntry(workspace, entry, "after");
    state.cursor += 1;
  }

  saveState(workspace, state);
  return { ok: true, cursor: state.cursor, id: target };
}

export function timeDiff(workspace, { id, maxFiles = 50, maxPreviewLines = 8 } = {}) {
  timeInit(workspace);
  const entry = loadEntry(workspace, String(id || ""));
  const changes = Array.isArray(entry.changes) ? entry.changes : [];
  const files = changes.filter((c) => c?.kind === "file").slice(0, Math.max(0, Math.min(500, Number(maxFiles) || 50)));

  const out = [];
  for (const ch of files) {
    const beforeBytes = ch.beforeExists && ch.beforeBlob ? Buffer.from(workspace.readFile(ch.beforeBlob)) : null;
    const afterBytes = ch.afterExists && ch.afterBlob ? Buffer.from(workspace.readFile(ch.afterBlob)) : null;
    const isText = (beforeBytes && shouldTreatAsText(beforeBytes)) || (afterBytes && shouldTreatAsText(afterBytes));

    const item = {
      kind: "file",
      path: ch.path,
      op: summarizeOp(ch),
      beforeSize: beforeBytes ? beforeBytes.length : 0,
      afterSize: afterBytes ? afterBytes.length : 0,
      isText
    };

    if (isText) {
      const beforeText = beforeBytes ? beforeBytes.toString("utf8") : "";
      const afterText = afterBytes ? afterBytes.toString("utf8") : "";
      const a = beforeText.split(/\r?\n/);
      const b = afterText.split(/\r?\n/);
      let start = 0;
      while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
      let endA = a.length - 1;
      let endB = b.length - 1;
      while (endA >= start && endB >= start && a[endA] === b[endB]) {
        endA -= 1;
        endB -= 1;
      }
      const preview = [];
      const ctx = Math.max(0, Math.min(10, Number(maxPreviewLines) || 0));
      const fromA = Math.max(0, start);
      const toA = Math.min(a.length, start + ctx);
      const fromB = Math.max(0, start);
      const toB = Math.min(b.length, start + ctx);
      for (let i = fromA; i < toA; i += 1) preview.push({ beforeLine: i + 1, before: a[i] });
      for (let i = fromB; i < toB; i += 1) preview.push({ afterLine: i + 1, after: b[i] });
      item.preview = preview;
      item.changedRegion = {
        before: { startLine: start + 1, endLine: endA + 1 },
        after: { startLine: start + 1, endLine: endB + 1 }
      };
    }

    out.push(item);
  }

  const dirChanges = changes.filter((c) => c?.kind === "dir").map((c) => ({ kind: "dir", path: c.path, op: summarizeOp(c) }));

  return {
    ok: true,
    id: entry.id,
    createdAt: entry.createdAt,
    tool: entry.tool,
    compactedFrom: entry.compactedFrom || [],
    files: out,
    dirs: dirChanges
  };
}
