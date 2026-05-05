# Knowledge Graph (graphify)

Voxnap ships with first-class support for [**graphify**](https://github.com/safishamsi/graphify) —
a privacy-first knowledge-graph builder that reads this monorepo (TS + Rust +
Markdown + diagrams) and produces an interactive map of how everything is wired
together.

It's especially useful here because Voxnap is built around a **single contract,
multiple platforms** rule (`ITranscriptionEngine` → Mock / Tauri / Wasm).
graphify makes that contract topology *visible*, and exposes it to your AI
assistant via MCP so questions like _"what does `WasmEngine` actually depend on
in `packages/core`?"_ become one-shot queries instead of grep marathons.

---

## TL;DR

```bash
# 1. One-time install (Python 3.10+ required).
pnpm graph:install

# 2. Build the graph.
pnpm graph

# 3. Open the interactive viewer.
#    Windows
start graphify-out\graph.html
#    macOS
open graphify-out/graph.html
#    Linux
xdg-open graphify-out/graph.html
```

Then point your AI assistant at the included MCP config and ask away.

---

## What you get

After `pnpm graph` finishes, `graphify-out/` contains:

| File | What it is |
|---|---|
| `graph.html` | Interactive vis.js graph — click nodes, search, filter by community |
| `GRAPH_REPORT.md` | God nodes, surprising connections, suggested questions |
| `graph.json` | Persistent graph; queryable weeks later without re-reading source |
| `obsidian/` | Drop-in Obsidian vault |
| `wiki/` | Wikipedia-style markdown articles per community (with `--wiki`) |
| `cache/` | SHA256 cache so re-runs only process changed files |

Every edge is tagged `EXTRACTED`, `INFERRED`, or `AMBIGUOUS` — so you always know
what was found in the AST vs. what the LLM guessed.

---

## Available scripts

All scripts live at the repo root and shell out to the `graphify` CLI installed
by `pnpm graph:install`.

| Command | What it does |
|---|---|
| `pnpm graph:install` | Installs the `graphifyy` PyPI package + Claude Code skill |
| `pnpm graph` | Full graph build of the entire monorepo |
| `pnpm graph:update` | Re-extract only files whose SHA256 changed (fast) |
| `pnpm graph:watch` | Auto-rebuild as you edit (instant for code, prompts for docs) |
| `pnpm graph:wiki` | Build the markdown wiki under `graphify-out/wiki/` |
| `pnpm graph:mcp` | Start the MCP stdio server (rarely run by hand — your IDE does this) |
| `pnpm graph:hook:install` | Install a `post-commit` git hook that auto-rebuilds |
| `pnpm graph:hook:uninstall` | Remove that hook |

---

## AI assistant integration (MCP)

Project-level MCP configurations are committed for every assistant the
maintainers actively use, so cloning the repo and opening it in any of these
clients is enough — no per-machine setup beyond `pnpm graph:install`.

| Client | Config file (committed) | How to enable |
|---|---|---|
| **VS Code** | `.vscode/mcp.json` | Requires VS Code 1.95+. Open the Command Palette → **MCP: List Servers** → **Start `graphify-voxnap`**. The schema entry gives you JSON IntelliSense too. |
| **Antigravity** | `.antigravity/mcp.json` (+ inherits `.vscode/mcp.json`) | Antigravity is a VS Code fork and reads both. The first time you open the workspace you'll see the **Trust MCP server** prompt — accept it. |
| **Gemini CLI** | `.gemini/settings.json` | Run `gemini` from the repo root; it auto-discovers `.gemini/settings.json` and registers `graphify-voxnap` under `mcpServers`. |
| **Claude Code** | `.mcp.json` | Standard project-scoped Claude Code config. The `/graphify` skill itself is also registered globally by `pnpm graph:install`. |
| **Cursor** | `.cursor/mcp.json` | Settings → MCP → reload. The server appears as `graphify-voxnap`. |
| **Windsurf** | `.windsurf/mcp.json` | Settings → MCP → reload. Identical surface to Cursor. |

All configs invoke the same command:

```json
{ "command": "graphify", "args": [".", "--mcp"] }
```

> **Why a separate `.mcp.json` at the root?**
> It's the convention used by Claude Code and a number of generic MCP clients
> (mcp-inspector, etc.). Keeping it duplicated avoids per-client surprises.

### Example prompts to try

Once the MCP server is connected, your assistant has graph tools. Some prompts
that work well on this codebase:

- _"Use graphify-voxnap to list every place `ITranscriptionEngine` is referenced
  and tell me which ones are implementations vs. consumers."_
- _"Use graphify-voxnap: explain the path between `cpal` (Rust) and the React
  `useTranscription` hook."_
- _"What god nodes does graphify see in `packages/core`? Are any of them
  surprising?"_
- _"Find INFERRED edges between `apps/web` and `packages/core` — flag any that
  cross the engine boundary instead of going through `ITranscriptionEngine`."_

The last one is the killer feature for this repo — graphify can flag any code
path that violates the engine contract rule from `AGENTS.md`.

---

## Auto-sync workflows

Pick whichever fits how you work:

- **`pnpm graph:watch`** in a side terminal. Code edits trigger an instant
  AST-only rebuild (no LLM cost). Doc/image edits print a prompt to run
  `pnpm graph:update` for the semantic re-pass.
- **`pnpm graph:hook:install`** — installs a `post-commit` hook so the graph is
  rebuilt on every commit. No background process needed; safe alongside
  existing hooks (graphify appends rather than overwrites).

Both ignore `models/`, `target/`, `node_modules/`, `dist/`, etc. via the same
patterns in `.gitignore`.

---

## Troubleshooting

**`graphify: command not found`**
Run `pnpm graph:install`. If that succeeds but the binary still isn't on PATH,
ensure the user-level Python `Scripts` (Windows) or `bin` (POSIX) directory is
on `PATH` — pip prints its location at the end of the install.

**MCP server doesn't appear in VS Code / Antigravity**
You need version 1.95+. Older builds silently ignore `.vscode/mcp.json`.
Check Output → **MCP** for a startup log.

**Gemini CLI says "no MCP servers"**
Make sure you ran it from the repo root (`gemini` resolves
`.gemini/settings.json` relative to CWD).

**Graph is empty / tiny**
The first run uses the LLM and may need an Anthropic API key. Set
`ANTHROPIC_API_KEY` in your environment, then re-run `pnpm graph`.
The cache lives in `graphify-out/cache/` — delete it if you want a clean rebuild.

**Re-runs are slow**
Use `pnpm graph:update` instead of `pnpm graph`. It only re-processes files
whose SHA256 changed.

---

## Privacy note

graphify-the-tool runs locally; its only network call is the Anthropic API for
the semantic extraction pass (and `--add` URL fetches if you use them). The
generated graph and cache stay in `graphify-out/`, which is git-ignored. None of
it is uploaded anywhere by graphify itself.

If you want a fully offline run for a single quick build, pass `--no-llm`
(graphify falls back to AST-only extraction; coverage is reduced but the code
graph is still useful).
