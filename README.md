# agent-zip-sandbox

ZIP-backed virtual workspace + JS/TS execution sandbox for agent workflows.

The goal is to give an LLM (or any agent) a **portable “virtual USB drive”** backed by a `.zip` file, plus a
way to **execute JavaScript/TypeScript** that reads/writes that virtual filesystem (not the host filesystem).

Note: the system prompt + tool schemas presented to the model refer to this as a “workspace” (not “ZIP workspace”),
to reduce confusion. The persistence format is still a `.zip`.

Core building blocks:

- **esbuild** (bundle + transpile) with plugins that load files from the ZIP workspace
- **node:vm** (execute compiled output in a constrained context)
- A **virtual `fs` / `fs/promises`** shim that reads/writes the ZIP workspace

## Threat model (important)

This is designed to prevent **accidental host damage** (e.g. scripts writing to `/etc`, reading `~/.ssh`,
spawning `rm -rf`, etc). It is **not** intended as a hardened boundary against a determined attacker.
`vm` is not a security boundary.

To improve safety further, run `src/sandbox_runner.js` in a **separate process** with:
- low privileges
- sanitized env
- strict timeouts
- (optional) OS sandboxing / containers / cgroups

## What you get (high-level)

- `ZipWorkspace`: in-memory VFS with ZIP import/export (`src/workspace.js`)
- LLM-style tool functions: read/write/list/stat/mkdir/delete + line patching (`src/tools.js`)
- `sandbox_runner`: stdin JSON → bundle-from-ZIP → run in VM → stdout JSON with updated ZIP (`src/sandbox_runner.js`)
- A simple host TUI that talks to a local OpenAI-compatible endpoint (Ollama) and autosaves the ZIP (`src/tui.js`)

## Quick start

```bash
npm i
npm run demo
```

## Architecture

### Data model: ZIP ⇄ in-memory workspace

`ZipWorkspace` stores:
- `files: Map<"/path", Uint8Array>`
- `dirs: Set<"/dir">` (always includes `/`)

The zip file is only used at the edges:
- Import: ZIP buffer → `ZipWorkspace`
- Export: `ZipWorkspace` → ZIP buffer

All paths are POSIX and rooted at `~/` (which maps to `/`).

### Execution pipeline: bundle → VM → updated ZIP

Execution is split into two parts:

1) **Bundling (esbuild)**: `src/esbuild_plugins.js` loads files from `ZipWorkspace` and provides shim modules:
   - `fs` / `fs/promises` shims that forward to an injected `__vfs`
   - a minimal POSIX-only `path` shim (so sandbox code can do `import path from "path"`)
   - a minimal `os` shim (`EOL`, `homedir()`, `tmpdir()`)

   All non-relative imports are blocked unless they are one of the shims above (everything else must live in the workspace).

2) **Runtime (node:vm)**: `src/vm_runner.js` runs the bundled CJS in a constrained context:
   - `eval` / `new Function` are disabled via `codeGeneration: { strings: false, wasm: false }`
   - `require(...)` is blocked (no host modules)
   - `console.*` is captured and returned as `stdout`/`stderr`

The `sandbox_runner` returns the updated workspace as a new ZIP.

## TUI (Ollama + gpt-oss:20b)

1) Make sure Ollama is running and has the model:

```bash
ollama pull gpt-oss:20b
```

2) Create/update `.env` (defaults are in `.env.example`).

3) Start a chat session against a ZIP file:

```bash
npm run tui -- --zip ./workspace.zip
```

Optional:

```bash
npm run tui -- --zip ./workspace.zip --verbose-tools
NO_COLOR=1 npm run tui -- --zip ./workspace.zip
```

This will also create/update a chat log next to the ZIP (default: `./workspace.zip.chat.json`) and will
**resume it** on the next run. Use `--chat <newfile>` (or delete the chat log) to start fresh.

The TUI autosaves the ZIP after **mutating** tool calls (writes/patches/deletes and `js_exec`).

## Time machine (history / undo / redo)

The workspace includes an internal history store under `~/.time/` (stored inside the workspace ZIP).

- The agent cannot see or modify `~/.time/`:
  - `fs_*` tools block it, and `fs_list ~/` filters it out.
  - `js_exec` code cannot access it via the sandbox `fs` shim.
- The host records a history entry after every mutating tool call (`fs_write`, `fs_patch_lines`, `fs_mkdir`, `fs_delete`, `js_exec`).
- History compacts older entries automatically (default: keep last 50, cap at 200; older entries are merged).

TUI commands:

```bash
:history [n]
:diff <id>
:undo [n]
:redo [n]
:restore <id>
```

Demo will:
1) create a workspace in RAM
2) write a small script that uses `fs` to write a file under `~/`
3) execute the script in the sandbox
4) read the resulting file back from the workspace
5) print the updated ZIP size and a few listings

## The execution protocol

`sandbox_runner.js` reads JSON on stdin:

```json
{
  "zipBase64": "<base64 zip>",
  "entryPath": "~/main.ts",
  "argv": ["--hello"],
  "env": { "FOO": "bar" },
  "timeoutMs": 1500
}
```

It writes JSON on stdout:

```json
{
  "ok": true,
  "stdout": "...",
  "stderr": "...",
  "exitCode": 0,
  "zipBase64": "<base64 zip (updated)>"
}
```

## Notes

- Paths are normalized as POSIX and rooted at `~/` (which maps to `/`).
- `fs` and `fs/promises` are shimmed to the workspace.
- `path` / `node:path` is a small POSIX-only shim (no host Node builtin modules are loaded at runtime).
- `os` / `node:os` is a small shim (`EOL`, `homedir()`, `tmpdir()`).
- Non-relative imports are blocked (everything must be in the workspace or a shim).

## Search

The tool surface includes a lightweight literal search:

- `fs_search({ query, path? })`

It returns small, patch-friendly contexts with line numbers. The intended workflow is:
1) `fs_search` to find relevant locations
2) `fs_read_lines` to fetch a slightly larger exact window (if needed)
3) `fs_patch_lines` to apply a precise edit

The search tool enforces conservative defaults (small context + limited results) to keep LLM context small.

### Future: BM25 indexing

If search becomes a bottleneck for large workspaces, consider adding an optional index built from file chunks:
- MiniSearch (pure JS, BM25-like scoring)
- Orama (pure JS, BM25/BM25F-style)

Keep the LLM output small by returning only a handful of best-matching chunks and then using line-based reads for precision.

## Extending the sandbox (where to change things)

- Add more allowed “builtin-like” APIs: implement a shim in `src/vfs_shims.js` and wire it in `src/esbuild_plugins.js`.
- Add/adjust LLM tools: implement in `src/tools.js` and update the tool schema in `src/tui.js`.
