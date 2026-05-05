#!/usr/bin/env node
/**
 * install-graphify.mjs
 *
 * Installs the `graphifyy` Python package (the CLI behind `graphify`) so the
 * Voxnap monorepo can produce a knowledge graph of itself and expose it to AI
 * assistants (VS Code, Antigravity, Gemini CLI, Claude Code, Cursor, Windsurf)
 * via the MCP server bundled with graphify.
 *
 * Why a wrapper? graphify is a Python tool (not on npm), so we need to:
 *   1. Locate a usable Python 3.10+ interpreter.
 *   2. Pick the right pip invocation on Windows vs. POSIX.
 *   3. Surface install errors with actionable hints instead of a stack trace.
 *
 * Usage:
 *   pnpm graph:install
 */

import { spawnSync } from "node:child_process";
import { platform } from "node:os";

const isWindows = platform() === "win32";

/**
 * Try a list of candidate executables and return the first one that responds
 * to `--version` with exit code 0.
 */
function findExecutable(candidates) {
  for (const exe of candidates) {
    const probe = spawnSync(exe, ["--version"], {
      stdio: "ignore",
      shell: isWindows, // resolve PATHEXT on Windows
    });
    if (probe.status === 0) return exe;
  }
  return null;
}

function run(cmd, args, { label }) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: isWindows,
  });
  if (result.status !== 0) {
    console.error(`\n✗ ${label} failed (exit ${result.status}).`);
    process.exit(result.status ?? 1);
  }
}

function main() {
  const python = findExecutable(["python3", "python", "py"]);
  if (!python) {
    console.error(
      [
        "✗ Could not find a Python interpreter on PATH.",
        "",
        "  graphify requires Python 3.10+. Install it from:",
        "    https://www.python.org/downloads/",
        "  …then re-run `pnpm graph:install`.",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(`✓ Using Python: ${python}`);

  // Use `python -m pip` so we always hit the pip belonging to *this* python,
  // even when there are multiple installations.
  run(python, ["-m", "pip", "install", "--upgrade", "graphifyy"], {
    label: "pip install graphifyy",
  });

  // `graphify install` registers the Claude Code skill (~/.claude/skills/...).
  // It's a no-op if Claude Code isn't installed, which is fine.
  console.log("\nRegistering /graphify Claude Code skill (best-effort)…");
  spawnSync("graphify", ["install"], {
    stdio: "inherit",
    shell: isWindows,
  });

  console.log(
    [
      "",
      "✓ graphify is installed.",
      "",
      "Next steps:",
      "  pnpm graph              # build a graph of this monorepo",
      "  pnpm graph:watch        # auto-rebuild as you edit",
      "  pnpm graph:mcp          # start MCP server for AI assistants",
      "",
      "MCP configs are already committed for VS Code, Antigravity,",
      "Gemini CLI, Claude Code, Cursor, and Windsurf. See docs/graphify.md.",
    ].join("\n"),
  );
}

main();
