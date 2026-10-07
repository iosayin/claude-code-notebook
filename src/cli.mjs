#!/usr/bin/env node
// claude-code-notebook CLI.
//   install [--project] [--dry-run]   add the hooks to Claude Code settings
//   uninstall [--project]             remove them
//   hook session-start | pre-compact  hook entry points (read JSON on stdin)
//   list | path | done <id>           look at and archive notebooks
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, listOpen, notebookDir, onPreCompact, onSessionStart, archive } from "./notebook.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MARK = "claude-code-notebook";
const [cmd, ...rest] = process.argv.slice(2);
const flag = (f) => rest.includes(f);

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

// Hooks must never break the session: always print valid JSON, always exit 0.
function runHook(fn) {
  let out = {};
  try {
    out = fn(readStdin(), config()) || {};
  } catch (e) {
    if (process.env.CLAUDE_NOTEBOOK_DEBUG) console.error(e);
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

function settingsFile() {
  return flag("--project")
    ? path.join(process.cwd(), ".claude", "settings.json")
    : path.join(os.homedir(), ".claude", "settings.json");
}

// The hooks run a stable copy, so `npx` is only needed once and hooks stay fast.
function installCopy() {
  const dest = path.join(os.homedir(), ".claude", MARK);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ["cli.mjs", "notebook.mjs"]) fs.copyFileSync(path.join(HERE, f), path.join(dest, f));
  fs.writeFileSync(path.join(dest, "package.json"), '{"type":"module"}\n');
  return path.join(dest, "cli.mjs");
}

function hookEntry(cli, name) {
  return { hooks: [{ type: "command", command: `node "${cli}" hook ${name}`, timeout: 15 }] };
}

function withoutOurs(list) {
  return (list || [])
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !String(h.command || "").includes(MARK)) }))
    .filter((g) => g.hooks.length);
}

function editSettings(mutate) {
  const file = settingsFile();
  let data = {};
  if (fs.existsSync(file)) {
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      console.error(`Could not parse ${file}. Fix it first; nothing was changed.`);
      process.exit(1);
    }
  }
  const next = mutate(structuredClone(data));
  const text = JSON.stringify(next, null, 2) + "\n";
  if (flag("--dry-run")) {
    console.log(`Would write ${file}:\n${text}`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.writeFileSync(file, text);
  console.log(`Updated ${file}${fs.existsSync(`${file}.bak`) ? ` (backup: ${file}.bak)` : ""}`);
}

switch (cmd) {
  case "hook":
    if (rest[0] === "session-start") runHook(onSessionStart);
    else if (rest[0] === "pre-compact") runHook(onPreCompact);
    else runHook(() => ({}));
    break;

  case "install": {
    const cli = flag("--dry-run") ? path.join(os.homedir(), ".claude", MARK, "cli.mjs") : installCopy();
    editSettings((s) => {
      s.hooks ||= {};
      s.hooks.SessionStart = [...withoutOurs(s.hooks.SessionStart), hookEntry(cli, "session-start")];
      s.hooks.PreCompact = [...withoutOurs(s.hooks.PreCompact), hookEntry(cli, "pre-compact")];
      return s;
    });
    if (!flag("--dry-run")) console.log(`Notebooks will be kept in ${config().rootDir}/<project>/. Restart Claude Code to load the hooks.`);
    break;
  }

  case "uninstall":
    editSettings((s) => {
      for (const ev of ["SessionStart", "PreCompact"]) {
        if (!s.hooks?.[ev]) continue;
        s.hooks[ev] = withoutOurs(s.hooks[ev]);
        if (!s.hooks[ev].length) delete s.hooks[ev];
      }
      if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
      return s;
    });
    console.log("Hooks removed. Your notebooks were not touched.");
    break;

  case "list": {
    const open = listOpen(process.cwd());
    if (!open.length) console.log(`No open notebooks in ${notebookDir(process.cwd())}`);
    for (const n of open) console.log(`${n.id}  ${new Date(n.mtime).toISOString().slice(0, 16).replace("T", " ")}  ${n.title}`);
    break;
  }

  case "path":
    console.log(notebookDir(process.cwd()));
    break;

  case "done": {
    if (!rest[0]) {
      console.error("Usage: claude-code-notebook done <id>");
      process.exit(1);
    }
    const dest = archive(process.cwd(), rest[0]);
    console.log(dest ? `Archived to ${dest}` : `No notebook ${rest[0]} in ${notebookDir(process.cwd())}`);
    break;
  }

  default:
    console.log(`claude-code-notebook: keeps Claude Code's working state across context compaction.

  npx claude-code-notebook install            add hooks to ~/.claude/settings.json
  npx claude-code-notebook install --project  add hooks to ./.claude/settings.json
  npx claude-code-notebook install --dry-run  show the change, write nothing
  npx claude-code-notebook uninstall          remove the hooks
  npx claude-code-notebook list               open notebooks for this folder
  npx claude-code-notebook done <id>          archive a finished notebook`);
}
