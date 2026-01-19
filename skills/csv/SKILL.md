---
name: csv
description: Safely inspect and transform CSV files in the workspace (no external deps).
---

# CSV

This skill helps you **inspect and transform CSV files** inside the virtual workspace.

## Guardrails

- Do **not** parse CSV with `split(",")` or other line-based heuristics; CSV allows quotes, commas, and newlines inside fields.
- Avoid `fs_patch_lines` for CSV content (quoted fields can span multiple lines). Prefer parse → transform → stringify.
- Be mindful of size: `js_exec` has a default timeout; sample first with `fs_read_lines` before transforming large files.

## Workflow (recommended)

1) Inspect input
- Use `fs_read_lines` to confirm delimiter, header row, and rough shape.

2) Ensure a CSV helper exists
- If `~/lib/csv.ts` does not exist, write it using the template below.

3) Write a transform script
- Create `~/scripts/csv_transform.ts` that reads input, transforms rows/objects, and writes output.

4) Execute and verify
- Run `js_exec({ entryPath: "~/scripts/csv_transform.ts" })`.
- Verify output with `fs_read_lines` / `fs_stat`.

## Template: `~/lib/csv.ts`

```ts
export function parseCsv(text, { delimiter = "," } = {}) {
  // Strip UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];

    if (inQuotes) {
      if (c === '\"') {
        // Escaped quote ("")
        if (text[i + 1] === '\"') {
          field += '\"';
          i += 1;
          continue;
        }
        inQuotes = false;
        continue;
      }
      field += c;
      continue;
    }

    if (c === '\"') {
      inQuotes = true;
      continue;
    }

    if (c === delimiter) {
      row.push(field);
      field = "";
      continue;
    }

    if (c === "\n" || c === "\r") {
      // CRLF or lone CR/LF
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      continue;
    }

    field += c;
  }

  if (inQuotes) {
    throw new Error("Invalid CSV: unterminated quote");
  }

  // Final row (avoid adding an extra empty row when the file ends with a newline)
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function escapeField(value, delimiter) {
  const s = String(value ?? "");
  const mustQuote = s.includes('"') || s.includes("\n") || s.includes("\r") || s.includes(delimiter);
  if (!mustQuote) return s;
  return '"' + s.replaceAll('"', '""') + '"';
}

export function stringifyCsv(rows, { delimiter = ",", trailingNewline = true } = {}) {
  const lines = rows.map((r) => r.map((v) => escapeField(v, delimiter)).join(delimiter));
  const out = lines.join("\n");
  return trailingNewline ? out + "\n" : out;
}

export function rowsToObjects(rows) {
  const headers = rows[0] ?? [];
  const objects = [];
  for (let i = 1; i < rows.length; i += 1) {
    const r = rows[i] ?? [];
    const obj = {};
    for (let j = 0; j < headers.length; j += 1) {
      obj[headers[j]] = r[j] ?? "";
    }
    objects.push(obj);
  }
  return { headers, objects };
}

export function objectsToRows(objects, headers) {
  const rows = [headers];
  for (const obj of objects) {
    rows.push(headers.map((h) => obj?.[h] ?? ""));
  }
  return rows;
}
```

## Template: `~/scripts/csv_transform.ts`

```ts
import fs from "fs";
import { parseCsv, stringifyCsv, rowsToObjects, objectsToRows } from "../lib/csv";

const INPUT = "~/data/in.csv";
const OUTPUT = "~/data/out.csv";

const text = fs.readFileSync(INPUT, "utf8");
const rows = parseCsv(text, { delimiter: "," });

const { objects } = rowsToObjects(rows);

// Example transform:
// - keep only a subset of columns
// - filter rows by a predicate
const keep = ["id", "status"];
const filtered = objects
  .filter((r) => r.status === "active")
  .map((r) => Object.fromEntries(keep.map((k) => [k, r[k]])));

const outRows = objectsToRows(filtered, keep);
fs.writeFileSync(OUTPUT, stringifyCsv(outRows, { delimiter: "," }));
console.log("Wrote", OUTPUT);
```
