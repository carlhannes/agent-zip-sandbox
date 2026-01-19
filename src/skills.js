import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_SKILLS_DIR = path.join(REPO_ROOT, "skills");

const VALID_SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function stripOneTrailingNewline(s) {
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}

function parseFrontmatter(md) {
  const text = String(md ?? "");
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { data: {}, body: text };
  }

  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return { data: {}, body: text };

  let endIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return { data: {}, body: text };

  const fmLines = lines.slice(1, endIdx);
  const body = lines.slice(endIdx + 1).join("\n");
  return { data: parseSimpleYaml(fmLines), body: stripOneTrailingNewline(body) };
}

function parseSimpleYaml(lines) {
  /** @type {Record<string, string>} */
  const out = {};

  const isIndent = (s) => /^[ \t]/.test(s);
  const stripQuotes = (s) => {
    const v = String(s ?? "").trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      return v.slice(1, -1);
    }
    return v;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || /^\s*#/.test(line)) continue;

    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2] ?? "";

    if (value === "|" || value === ">") {
      const parts = [];
      let j = i + 1;
      while (j < lines.length && isIndent(lines[j])) {
        parts.push(lines[j].replace(/^[ \t]+/, ""));
        j += 1;
      }
      i = j - 1;
      out[key] = parts.join("\n").trimEnd();
      continue;
    }

    out[key] = stripQuotes(value);
  }

  return out;
}

function normalizeSkillName(name) {
  const n = String(name ?? "").trim();
  if (!VALID_SKILL_NAME.test(n)) return null;
  return n;
}

function fallbackDescription(body) {
  const lines = String(body ?? "").split(/\r?\n/);
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    if (s.startsWith("#")) continue;
    return s.slice(0, 200);
  }
  return "";
}

export async function loadSkillsIndex({ skillsDir = DEFAULT_SKILLS_DIR, maxSkillBytes = 200_000 } = {}) {
  /** @type {{ name: string; description: string }[]} */
  const skills = [];
  /** @type {Map<string, { name: string; description: string; content: string; path: string }>} */
  const byName = new Map();

  let dirents = [];
  try {
    dirents = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return { skillsDir, skills, byName };
    throw err;
  }

  for (const ent of dirents) {
    if (!ent.isDirectory()) continue;
    const dirName = ent.name;
    const skillMdPath = path.join(skillsDir, dirName, "SKILL.md");

    let raw = "";
    try {
      const buf = await fs.readFile(skillMdPath);
      if (buf.length > maxSkillBytes) continue;
      raw = buf.toString("utf8");
    } catch (err) {
      if (err?.code === "ENOENT") continue;
      throw err;
    }

    const { data, body } = parseFrontmatter(raw);

    const dirSkillName = normalizeSkillName(dirName);
    const fmSkillName = normalizeSkillName(data.name);

    if (fmSkillName && dirSkillName && fmSkillName !== dirSkillName) {
      // Avoid ambiguity: require the folder name and frontmatter name to match.
      continue;
    }

    const name = fmSkillName || dirSkillName;
    if (!name) continue;
    if (byName.has(name)) continue;

    const description = String(data.description || fallbackDescription(body)).trim();

    byName.set(name, { name, description, content: raw, path: skillMdPath });
    skills.push({ name, description });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skillsDir, skills, byName };
}

export function formatSkillsReminderForModel(skillsIndex, { maxSkills = 20, maxChars = 1200 } = {}) {
  const skills = Array.isArray(skillsIndex?.skills) ? skillsIndex.skills : [];

  const hasCsv = skills.some((s) => s?.name === "csv");
  const headerLines = [
    "Skills reminder:",
    "- List skills with `skill_list`.",
    "- Load a skill with `skill_load({ name })` before following its instructions."
  ];
  if (hasCsv) {
    headerLines.push('- If the user mentions a `.csv` path or asks for CSV work: MUST call `skill_load({ "name": "csv" })` first.');
  }
  headerLines.push("", "Available skills:");
  const header = headerLines.join("\n");

  const lines = [];
  const shown = skills.slice(0, Math.max(0, Math.min(100, Number(maxSkills) || 20)));
  if (shown.length === 0) {
    lines.push("(none)");
  } else {
    for (const s of shown) {
      const name = String(s?.name ?? "");
      const desc = String(s?.description ?? "").trim();
      lines.push(desc ? `- ${name}: ${desc}` : `- ${name}`);
    }
    if (skills.length > shown.length) lines.push(`… (${skills.length - shown.length} more)`);
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
