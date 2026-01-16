# agent-zip-sandbox

This repo is a small reference implementation for:
- a ZIP-backed **virtual workspace** (`~/`-rooted POSIX paths), and
- a JS/TS execution “sandbox” that reads/writes that workspace via shims (not the host filesystem).

For user-facing docs and usage, see `README.md`.

Note: the system prompt + tool schemas shown to the model call it a “workspace” (not “ZIP workspace”).

## Commands

- Install deps: `npm i`
- Smoke test (no LLM): `npm run demo`
- Chat TUI (Ollama): `npm run tui -- --zip ./workspace.zip`
  - Verbose tool logs: `--verbose-tools`
  - Disable ANSI colors: `NO_COLOR=1 ...`

## Architecture map

- Workspace:
  - `src/workspace.js`: `ZipWorkspace` (ZIP import/export + FS-like ops)
  - `src/path_utils.js`: `normPath()` canonicalization (POSIX, `~/` root)
  - `src/tools.js`: LLM-friendly FS tools (`fs_*`, including `fs_read_lines` + `fs_patch_lines`)
- Sandbox execution:
  - `src/esbuild_plugins.js`: loads workspace modules + provides shim modules; blocks non-relative imports
  - `src/vfs_shims.js`: source generators for shim modules (`fs`, `fs/promises`, `path`, `os`)
  - `src/vm_runner.js`: runs bundled output in `node:vm` (no host `require`, eval disabled)
  - `src/sandbox_runner.js`: stdin JSON → bundle → VM run → stdout JSON (updated ZIP)
- Host integration:
  - `src/host_session.js`: spawns `sandbox_runner`, persists ZIP after mutating tool calls
  - `src/tui.js`: simple REPL that uses Ollama’s OpenAI-compatible endpoint + tool-calling
  - `src/chat_store.js`: chat persistence (outside the ZIP)
  - `src/persist.js`: atomic file writes for ZIP/chat logs
  - `src/ui.js`: ANSI formatting + tool summaries for the TUI

## Invariants (keep these true)

- **No host Node builtins at runtime** inside the sandbox:
  - `src/vm_runner.js` blocks `require(...)`.
  - `src/esbuild_plugins.js` blocks all non-relative imports except explicit shims.
  - If you need a “builtin-like” API (e.g. `path`), add it as a shim (don’t re-enable host `require`).
- **Paths are POSIX** and rooted at `~/` (maps to `/`).
- Prefer **line-based edits** for LLMs: `fs_read_lines` + `fs_patch_lines` over whole-file rewrites.
- Prefer **search → read → patch** workflows: `fs_search` → `fs_read_lines` → `fs_patch_lines`.

## GOTCHAs

- The TUI **resumes** the default chat log (`<zip>.chat.json`) if it exists; the model may skip re-reading files.
  - Start fresh with `--chat new.chat.json` or delete the log file.
- If the assistant “claims” it read/wrote something but you didn’t see tool logs, it likely didn’t actually call tools.
  - The chat log is the source of truth; grep for `tool_calls` / `role: "tool"`.
- Trailing slashes are common in model output; `normPath()` strips them (except `/`) so `~/out/` and `~/out` behave the same.
