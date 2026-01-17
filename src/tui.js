import dotenv from "dotenv";
import OpenAI from "openai";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadWorkspaceFromZipPath, saveWorkspaceToZipPath, createHostToolHandlers } from "./host_session.js";
import { loadChatState, saveChatState } from "./chat_store.js";
import { makeStyles, indentLines, formatToolArgs, summarizeToolResult } from "./ui.js";

dotenv.config();

function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--zip" || a === "--chat" || a === "--model" || a === "--base-url") {
      const v = argv[i + 1];
      if (!v || v.startsWith("--")) throw new Error(`Missing value for ${a}`);
      out[a.slice(2)] = v;
      i += 1;
      continue;
    }
    if (a === "--verbose-tools") {
      out["verbose-tools"] = true;
      continue;
    }
    if (a === "--help" || a === "-h") {
      out.help = true;
      continue;
    }
    throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}

function getToolSchemas() {
  return [
    {
      type: "function",
      function: {
        name: "fs_read",
        description: "Read a file from the workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "POSIX path rooted at ~/" }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "fs_read_lines",
        description: "Read a range of lines (1-based) from a UTF-8 text file in the workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "POSIX path rooted at ~/" },
            startLine: { type: "number", description: "1-based start line (inclusive)." },
            endLine: { type: "number", description: "1-based end line (inclusive)." }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "fs_search",
        description:
          "Search for a literal substring across text files in the workspace and return small, patch-friendly line contexts.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Literal substring to search for." },
            path: { type: "string", description: "Search scope (directory or file path), rooted at ~/." }
          },
          required: ["query"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "fs_write",
        description: "Write a file in the workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "POSIX path rooted at ~/" },
            content: { type: "string", description: "UTF-8 text content." }
          },
          required: ["path", "content"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "fs_patch_lines",
        description: "Replace a range of lines (1-based, inclusive) in a UTF-8 text file.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "POSIX path rooted at ~/" },
            startLine: { type: "number" },
            endLine: { type: "number" },
            replacement: { type: "string" }
          },
          required: ["path", "startLine", "endLine", "replacement"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "fs_list",
        description: "List directory entries in the workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "POSIX path rooted at ~/" }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "fs_stat",
        description: "Stat a file or directory in the workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "POSIX path rooted at ~/" }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "fs_mkdir",
        description: "Create a directory in the workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "POSIX path rooted at ~/" }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "fs_delete",
        description: "Delete a file or empty directory in the workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "POSIX path rooted at ~/" }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "js_exec",
        description:
          "Execute a JS/TS entry file inside the workspace. The runtime has a virtual fs and does not load host Node modules.",
        parameters: {
          type: "object",
          properties: {
            entryPath: { type: "string", description: "POSIX path rooted at ~/" },
            argv: { type: "array", items: { type: "string" } }
          },
          required: ["entryPath"],
          additionalProperties: false
        }
      }
    }
  ];
}

function makeSystemPrompt() {
  return [
    "You are an AI agent working inside a sandboxed virtual filesystem.",
    "",
    "Rules:",
    "- The virtual filesystem root is `~/` (POSIX paths only).",
    "- You must use the provided fs_* tools to read/write/list/stat/mkdir/delete files.",
    "- Use `fs_search` to locate relevant code/strings without reading entire files.",
    "- Prefer `fs_read_lines` + `fs_patch_lines` for edits; avoid rewriting entire files.",
    "- Use `js_exec` to run code inside the workspace. It can only access the virtual filesystem.",
    "- Do not assume you can access the host machine, network, or any host Node.js built-in modules.",
    "",
    "Notes:",
    "- `fs` and `fs/promises` are virtual shims inside the sandbox.",
    "- `path` is a POSIX-only shim (use it for basic join/dirname/basename/normalize if needed).",
    "- `os` is a minimal shim (EOL, homedir(), tmpdir())."
  ].join("\n");
}

function usage() {
  return [
    "Usage:",
    "  npm run tui -- --zip <path/to/workspace.zip> [--chat <path/to/chat.json>] [--model <model>] [--base-url <url>] [--verbose-tools]",
    "",
    "Commands:",
    "  :quit               Exit",
    "  :history [n]        Show recent workspace history",
    "  :diff <id>          Show a small diff summary for a history entry",
    "  :undo [n]           Undo last change(s)",
    "  :redo [n]           Redo change(s)",
    "  :restore <id>       Restore workspace to a specific history entry",
    "",
    "Options:",
    "  --verbose-tools   Print full tool JSON + autosave info",
    "",
    "Defaults:",
    "  --chat defaults to <zip>.chat.json",
    "  --model defaults to env MODEL or gpt-oss:20b",
    "  --base-url defaults to env OPENAI_BASE_URL or http://localhost:11434/v1",
    "  Set NO_COLOR=1 to disable ANSI colors"
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  const zipPath = /** @type {string|undefined} */ (args.zip);
  if (!zipPath) {
    console.error("Missing --zip");
    console.error(usage());
    process.exit(1);
  }

  const chatPath = /** @type {string|undefined} */ (args.chat) || `${zipPath}.chat.json`;
  const model = /** @type {string|undefined} */ (args.model) || process.env.MODEL || "gpt-oss:20b";
  const baseURL =
    /** @type {string|undefined} */ (args["base-url"]) ||
    process.env.OPENAI_BASE_URL ||
    process.env.OLLAMA_BASE_URL ||
    "http://localhost:11434/v1";
  const apiKey = process.env.OPENAI_API_KEY || "ollama";
  const verboseTools = Boolean(args["verbose-tools"]);

  const client = new OpenAI({ apiKey, baseURL });
  const styles = makeStyles();
  const roleAssistant = styles.bold("assistant:");
  const roleTool = styles.bold("tool:");

  const { workspace, existed } = await loadWorkspaceFromZipPath(zipPath);
  if (!existed) {
    await saveWorkspaceToZipPath(workspace, zipPath);
  }
  const { handlers: toolHandlers, getLastPersist, time } = createHostToolHandlers({ workspace, zipPath });

  const systemPrompt = makeSystemPrompt();
  const loadedChatState = await loadChatState(chatPath);
  const resumed = Boolean(loadedChatState);
  let chatState = loadedChatState;
  if (!chatState) {
    chatState = {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      zipPath,
      model,
      baseURL,
      messages: [{ role: "system", content: systemPrompt }]
    };
    await saveChatState(chatPath, chatState);
  } else {
    chatState.zipPath = zipPath;
    chatState.model = model;
    chatState.baseURL = baseURL;
    if (!chatState.messages.some((m) => m?.role === "system")) {
      chatState.messages.unshift({ role: "system", content: systemPrompt });
    }
    await saveChatState(chatPath, chatState);
  }

  console.log(`Workspace ZIP: ${zipPath}`);
  console.log(`Chat log:      ${chatPath}`);
  console.log(`Chat session:  ${resumed ? "resumed" : "new"} (${chatState.messages.length} messages)`);
  if (resumed) console.log(styles.dim("Tip: pass --chat <newfile> (or delete the chat log) to start fresh."));
  console.log(`Model:         ${model}`);
  console.log(`Base URL:      ${baseURL}`);
  console.log(`Colors:        ${styles.enabled ? "on" : "off"}${process.env.NO_COLOR ? " (NO_COLOR)" : ""}`);
  console.log(`Verbose tools: ${verboseTools ? "on" : "off"}`);
  console.log("");

  const rl = readline.createInterface({ input, output });

  function printAssistantText(text) {
    const s = String(text ?? "").trimEnd();
    if (!s) return;
    const lines = s.split(/\r?\n/);
    if (lines.length === 1) {
      console.log(`${roleAssistant} ${lines[0]}`);
      return;
    }
    console.log(`${roleAssistant} ${lines[0]}`);
    console.log(indentLines(lines.slice(1).join("\n"), "  "));
  }

  async function runToolLoop() {
    const tools = getToolSchemas();

    for (let iter = 0; iter < 25; iter += 1) {
      const resp = await client.chat.completions.create({
        model,
        messages: chatState.messages,
        tools,
        tool_choice: "auto"
      });

      const msg = resp?.choices?.[0]?.message;
      if (!msg) {
        console.error("No assistant message returned.");
        return;
      }

      chatState.messages.push({
        role: "assistant",
        content: msg.content ?? "",
        tool_calls: msg.tool_calls
      });
      await saveChatState(chatPath, chatState);

      const toolCalls = msg.tool_calls || [];
      if (toolCalls.length === 0) {
        printAssistantText(msg.content);
        return;
      }

      printAssistantText(msg.content);
      console.log(styles.yellow(`-- tool round ${iter + 1}: ${toolCalls.length} call(s) --`));

      for (const tc of toolCalls) {
        const toolName = tc?.function?.name;
        const rawArgs = tc?.function?.arguments ?? "{}";
        let argsObj = {};

        if (!toolName || !tc?.id) {
          const out = { ok: false, error: "Malformed tool call", toolCall: tc };
          chatState.messages.push({
            role: "tool",
            tool_call_id: tc?.id ?? "missing_id",
            content: JSON.stringify(out)
          });
          await saveChatState(chatPath, chatState);
          console.log(`${roleTool} ${styles.red("✗")} ${styles.cyan("malformed tool call")}`);
          if (verboseTools) console.log(indentLines(styles.dim(JSON.stringify(out, null, 2)), "  "));
          continue;
        }

        try {
          argsObj = rawArgs ? JSON.parse(rawArgs) : {};
        } catch (err) {
          const out = {
            ok: false,
            error: `Invalid JSON arguments for ${toolName}: ${String(err?.message || err)}`,
            rawArguments: rawArgs
          };
          chatState.messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(out) });
          await saveChatState(chatPath, chatState);
          console.log(`${roleTool} ${styles.red("✗")} ${styles.cyan(toolName)} ${styles.red("invalid JSON arguments")}`);
          if (verboseTools) console.log(indentLines(styles.dim(JSON.stringify(out, null, 2)), "  "));
          continue;
        }

        const handler = toolHandlers[toolName];
        const argsSummary = formatToolArgs(toolName, argsObj);
        console.log(`${roleTool} ${styles.cyan("→")} ${styles.cyan(toolName)} ${styles.dim(argsSummary)}`.trimEnd());

        const persistBefore = getLastPersist()?.ts ?? null;
        const startMs = Date.now();
        let out = null;
        if (!handler) {
          out = { ok: false, error: `Unknown tool: ${toolName}` };
        } else {
          try {
            out = await handler(argsObj);
          } catch (err) {
            out = { ok: false, error: String(err?.message || err), stack: err?.stack || "" };
          }
        }
        const durMs = Date.now() - startMs;
        const isOk = !(out && typeof out === "object" && out.ok === false);
        const mark = isOk ? styles.green("✓") : styles.red("✗");
        const summary = summarizeToolResult(toolName, out);
        console.log(`${roleTool} ${mark} ${styles.cyan(toolName)} ${styles.dim(summary)} ${styles.dim(`(${durMs}ms)`)}`.trimEnd());

        if (verboseTools) {
          console.log(indentLines(styles.dim(JSON.stringify(out, null, 2)), "  "));
          const persistAfter = getLastPersist();
          if (persistAfter?.ts && persistAfter.ts !== persistBefore) {
            console.log(indentLines(styles.dim(`saved zip: ${persistAfter.bytes} bytes`), "  "));
          }
        }

        chatState.messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(out) });
        await saveChatState(chatPath, chatState);
      }
    }

    console.error("Stopped after too many tool iterations (possible loop).");
  }

  while (true) {
    const line = await rl.question("> ");
    const text = (line ?? "").trim();
    if (!text) continue;
    if (text === ":quit" || text === ":q" || text === "exit") break;

    if (text.startsWith(":")) {
      const parts = text.slice(1).trim().split(/\s+/).filter(Boolean);
      const cmd = parts[0] || "";
      const arg1 = parts[1] || "";

      if (cmd === "history") {
        try {
          const limit = arg1 ? Number(arg1) : 20;
          const h = time.history({ limit });
          console.log(styles.yellow(`-- history (cursor ${h.cursor}/${h.total}) --`));
          for (let i = 0; i < h.entries.length; i += 1) {
            const e = h.entries[i];
            const absIndex = h.total - h.entries.length + i;
            const marker = absIndex < h.cursor ? styles.green("●") : styles.dim("○");
            const compacted = e.compacted ? styles.dim(" (compacted)") : "";
            console.log(
              `${marker} ${styles.cyan(e.id)} ${styles.dim(e.createdAt)} ${styles.dim(e.tool)} ${styles.dim(
                `${e.changedPaths} change(s)`
              )}${compacted}`
            );
          }
        } catch (err) {
          console.log(styles.red(`history failed: ${String(err?.message || err)}`));
        }
        continue;
      }

      if (cmd === "diff") {
        if (!arg1) {
          console.log(styles.red("Usage: :diff <id>"));
          continue;
        }
        try {
          const d = time.diff({ id: arg1 });
          if (!d.ok) {
            console.log(styles.red(`diff failed: ${d.error || "unknown error"}`));
            continue;
          }
          console.log(styles.yellow(`-- diff ${d.id} (${d.tool}) ${styles.dim(d.createdAt)} --`));
          for (const f of d.files || []) {
            console.log(
              `${styles.cyan(f.op)} ${styles.cyan(f.path)} ${styles.dim(`${f.beforeSize}→${f.afterSize} bytes`)}${
                f.isText ? styles.dim(" (text)") : styles.dim(" (binary)")
              }`
            );
          }
          for (const dd of d.dirs || []) {
            console.log(`${styles.cyan(dd.op)} ${styles.cyan(dd.path)}`);
          }
        } catch (err) {
          console.log(styles.red(`diff failed: ${String(err?.message || err)}`));
        }
        continue;
      }

      if (cmd === "undo" || cmd === "redo") {
        try {
          const steps = arg1 ? Number(arg1) : 1;
          const action = cmd === "undo" ? time.undo : time.redo;
          const res = await action({ steps });
          console.log(styles.yellow(`-- ${cmd} --`));
          console.log(styles.dim(JSON.stringify(res)));
          chatState.messages.push({
            role: "system",
            content: `Workspace changed by host command :${cmd} (${Number.isFinite(steps) ? steps : 1} step(s)) at ${new Date().toISOString()}. Re-check files before proceeding.`
          });
          await saveChatState(chatPath, chatState);
        } catch (err) {
          console.log(styles.red(`${cmd} failed: ${String(err?.message || err)}`));
        }
        continue;
      }

      if (cmd === "restore") {
        if (!arg1) {
          console.log(styles.red("Usage: :restore <id>"));
          continue;
        }
        try {
          const res = await time.restore({ id: arg1 });
          if (!res.ok) {
            console.log(styles.red(`restore failed: ${res.error || "unknown error"}`));
            continue;
          }
          console.log(styles.yellow(`-- restore --`));
          console.log(styles.dim(JSON.stringify(res)));
          chatState.messages.push({
            role: "system",
            content: `Workspace changed by host command :restore (${arg1}) at ${new Date().toISOString()}. Re-check files before proceeding.`
          });
          await saveChatState(chatPath, chatState);
        } catch (err) {
          console.log(styles.red(`restore failed: ${String(err?.message || err)}`));
        }
        continue;
      }

      console.log(styles.red(`Unknown command: ${text}`));
      continue;
    }

    chatState.messages.push({ role: "user", content: line });
    await saveChatState(chatPath, chatState);

    try {
      await runToolLoop();
    } catch (err) {
      console.error(`Error: ${String(err?.message || err)}`);
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
