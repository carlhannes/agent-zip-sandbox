const VALID_STATUSES = new Set(["pending", "in_progress", "completed", "canceled"]);

function coerceStatus(status) {
  const s = String(status ?? "").trim();
  return VALID_STATUSES.has(s) ? s : null;
}

function checkboxForStatus(status) {
  switch (status) {
    case "completed":
      return "[x]";
    case "in_progress":
      return "[>]";
    case "canceled":
      return "[-]";
    case "pending":
    default:
      return "[ ]";
  }
}

function truncate(s, maxLen) {
  const str = String(s ?? "");
  if (str.length <= maxLen) return str;
  return str.slice(0, Math.max(0, maxLen - 1)) + "…";
}

export function normalizeAndValidatePlanItems(items, { maxItems = 100, maxStepLength = 500 } = {}) {
  if (!Array.isArray(items)) return { ok: false, error: "items must be an array" };

  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    if (out.length >= maxItems) break;
    const it = items[i];
    if (!it || typeof it !== "object") return { ok: false, error: `items[${i}] must be an object` };

    const step = String(it.step ?? "").trim();
    if (!step) return { ok: false, error: `items[${i}].step must be a non-empty string` };
    if (step.length > maxStepLength) return { ok: false, error: `items[${i}].step too long` };

    const status = coerceStatus(it.status);
    if (!status) return { ok: false, error: `items[${i}].status must be one of: pending,in_progress,completed,canceled` };

    out.push({ step, status });
  }

  const inProgress = out.filter((it) => it.status === "in_progress").length;
  if (inProgress > 1) return { ok: false, error: "at most one item can be in_progress" };

  return { ok: true, items: out };
}

export function formatPlanForTui(plan, { styles } = {}) {
  const items = Array.isArray(plan?.items) ? plan.items : [];
  if (items.length === 0) return styles?.dim ? styles.dim("(no plan items)") : "(no plan items)";

  const width = String(items.length).length;
  const lines = [];
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    const step = String(it?.step ?? "");
    const status = String(it?.status ?? "pending");
    const box = checkboxForStatus(status);
    const line = `${String(i + 1).padStart(width, " ")}. ${box} ${step}`;

    if (!styles) {
      lines.push(line);
      continue;
    }

    if (status === "completed") lines.push(styles.green(line));
    else if (status === "in_progress") lines.push(styles.yellow(line));
    else if (status === "canceled") lines.push(styles.dim(line));
    else lines.push(line);
  }

  return lines.join("\n");
}

export function formatPlanReminderForModel(plan, { maxChars = 1200 } = {}) {
  const items = Array.isArray(plan?.items) ? plan.items : [];
  const header = [
    "Planning reminder:",
    "- Keep a short TODO plan via `plan_update` (update only when it changes).",
    "- Keep at most one item `in_progress`.",
    "- The user can ask to see it with `:plan`.",
    "",
    "Current plan:"
  ].join("\n");

  const lines = [];
  if (items.length === 0) {
    lines.push("(no plan items)");
  } else {
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      const status = String(it?.status ?? "pending");
      const box = checkboxForStatus(status);
      const step = truncate(String(it?.step ?? ""), 160);
      lines.push(`${i + 1}. ${box} ${step}`);
    }
  }

  const full = `${header}\n${lines.join("\n")}`.trimEnd();
  if (full.length <= maxChars) return full;

  // Truncate by lines while keeping header.
  const kept = [];
  let used = header.length + 1;
  for (let i = 0; i < lines.length; i += 1) {
    const ln = lines[i];
    if (used + ln.length + 1 > maxChars) break;
    kept.push(ln);
    used += ln.length + 1;
  }
  const omitted = Math.max(0, lines.length - kept.length);
  const suffix = omitted ? `… (${omitted} more)` : "";
  return `${header}\n${kept.join("\n")}${suffix ? `\n${suffix}` : ""}`.trimEnd();
}
