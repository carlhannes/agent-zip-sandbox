export function supportsColor() {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

export function makeStyles({ enabled = supportsColor() } = {}) {
  const wrap = (open, s) => (enabled ? `\u001b[${open}m${s}\u001b[0m` : s);
  return {
    enabled,
    bold: (s) => wrap("1", s),
    dim: (s) => wrap("2", s),
    red: (s) => wrap("31", s),
    green: (s) => wrap("32", s),
    yellow: (s) => wrap("33", s),
    cyan: (s) => wrap("36", s)
  };
}

export function indentLines(text, prefix = "  ") {
  const s = String(text ?? "");
  const lines = s.split(/\r?\n/);
  return lines.map((l) => `${prefix}${l}`).join("\n");
}

function truncateMiddle(s, maxLen) {
  const str = String(s);
  if (str.length <= maxLen) return str;
  const head = Math.max(0, Math.floor((maxLen - 3) / 2));
  const tail = Math.max(0, maxLen - 3 - head);
  return `${str.slice(0, head)}...${str.slice(str.length - tail)}`;
}

function fmtValue(v) {
  if (typeof v === "string") return JSON.stringify(truncateMiddle(v, 120));
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === "object") return "{...}";
  return String(v);
}

export function formatToolArgs(toolName, args) {
  const a = args && typeof args === "object" ? args : {};
  const fields = [];

  const push = (k, v) => {
    if (v === undefined) return;
    fields.push(`${k}=${fmtValue(v)}`);
  };

  switch (toolName) {
    case "fs_read":
      push("path", a.path);
      break;
    case "fs_read_lines":
      push("path", a.path);
      push("startLine", a.startLine);
      push("endLine", a.endLine);
      break;
    case "fs_write":
      push("path", a.path);
      if (typeof a.content === "string") push("contentLen", a.content.length);
      break;
    case "fs_patch_lines":
      push("path", a.path);
      push("startLine", a.startLine);
      push("endLine", a.endLine);
      if (typeof a.replacement === "string") push("replacementLen", a.replacement.length);
      break;
    case "fs_list":
    case "fs_stat":
    case "fs_mkdir":
    case "fs_delete":
      push("path", a.path);
      if (toolName === "fs_mkdir") push("recursive", a.recursive);
      break;
    case "fs_search":
      push("query", a.query);
      push("path", a.path ?? a.pathPrefix);
      break;
    case "js_exec":
      push("entryPath", a.entryPath);
      if (Array.isArray(a.argv)) push("argv", a.argv);
      break;
    case "plan_read":
      break;
    case "plan_update":
      if (Array.isArray(a.items)) push("items", a.items);
      break;
    default: {
      const keys = Object.keys(a).slice(0, 6);
      for (const k of keys) push(k, a[k]);
      if (Object.keys(a).length > keys.length) fields.push("…");
    }
  }

  return fields.length ? `(${fields.join(" ")})` : "";
}

export function summarizeToolResult(toolName, out) {
  if (!out || typeof out !== "object") return String(out);

  if (out.ok === false) {
    const err = out.error ? truncateMiddle(out.error, 200) : "error";
    return `error=${JSON.stringify(err)}`;
  }

  switch (toolName) {
    case "plan_read":
    case "plan_update": {
      const items = Array.isArray(out.plan?.items) ? out.plan.items : [];
      const inProgress = items.filter((it) => it?.status === "in_progress").length;
      return `items=${items.length} in_progress=${inProgress}`;
    }
    case "fs_read": {
      const enc = out.encoding || "utf8";
      const len = typeof out.content === "string" ? out.content.length : 0;
      return `encoding=${enc} contentLen=${len}`;
    }
    case "fs_read_lines": {
      const n = Array.isArray(out.lines) ? out.lines.length : 0;
      if (Number.isFinite(out.startLine) && Number.isFinite(out.endLine) && Number.isFinite(out.totalLines)) {
        return `lines=${n} range=${out.startLine}-${out.endLine}/${out.totalLines}`;
      }
      return `lines=${n}`;
    }
    case "fs_list": {
      const entries = Array.isArray(out.entries) ? out.entries : [];
      const shown = entries.slice(0, 10);
      const suffix = entries.length > shown.length ? " …" : "";
      return `entries=${entries.length}${entries.length ? ` [${shown.join(", ")}${suffix}]` : ""}`;
    }
    case "fs_search": {
      const results = Array.isArray(out.results) ? out.results : [];
      const truncated = out.truncated ? " truncated" : "";
      return `results=${results.length}${truncated}`;
    }
    case "fs_stat":
      return `type=${out.type} size=${out.size}`;
    case "js_exec": {
      const exitCode = out.exitCode ?? 0;
      const outLen = typeof out.stdout === "string" ? out.stdout.length : 0;
      const errLen = typeof out.stderr === "string" ? out.stderr.length : 0;
      return `exitCode=${exitCode} stdoutLen=${outLen} stderrLen=${errLen}`;
    }
    default:
      if (typeof out.path === "string") return `ok path=${out.path}`;
      return "ok";
  }
}
