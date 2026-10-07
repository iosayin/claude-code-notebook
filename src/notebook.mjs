// Core logic: where notebooks live, what the hooks read and write.
// Zero dependencies. Every hook entry point must never throw: a broken hook
// must not break a Claude Code session, so callers wrap these in try/catch.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const AUTO_START = "<!-- notebook:auto -->";
export const AUTO_END = "<!-- /notebook:auto -->";

export function config(env = process.env) {
  const num = (name, def) => {
    const v = Number(env[name]);
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  return {
    rootDir: env.CLAUDE_NOTEBOOK_DIR || path.join(os.homedir(), ".claude", "notebooks"),
    maxChars: num("CLAUDE_NOTEBOOK_MAX_CHARS", 20000),
    requests: num("CLAUDE_NOTEBOOK_REQUESTS", 8),
    openDays: num("CLAUDE_NOTEBOOK_OPEN_DAYS", 7),
    nudge: env.CLAUDE_NOTEBOOK_NUDGE !== "off",
  };
}

// Same idea as Claude Code's own project folders: one folder per working directory.
export function projectSlug(cwd) {
  const s = String(cwd || "unknown").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "unknown";
}

export function shortId(sessionId) {
  return String(sessionId || "unknown").replace(/[^A-Za-z0-9-]/g, "").slice(0, 8) || "unknown";
}

export function notebookDir(cwd, cfg = config()) {
  return path.join(cfg.rootDir, projectSlug(cwd));
}

export function notebookPath(cwd, sessionId, cfg = config()) {
  return path.join(notebookDir(cwd, cfg), `${shortId(sessionId)}.md`);
}

// ---------------------------------------------------------------- redaction
// Auto-captured text comes from the transcript and may contain secrets the
// user pasted. Mask the common shapes before anything touches disk.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, // Telegram bot token
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];
// Patterns that keep a readable prefix and mask only the value.
const KEEP_PREFIX = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, "$1 [redacted]"],
  [/\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY|PRIVATE_KEY)[A-Za-z0-9_]*)(\s*[=:]\s*)["']?[^\s"']{6,}["']?/gi, "$1$2[redacted]"],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, "$1[redacted]@"], // credentials inside URLs
];

export function redact(text) {
  let out = String(text ?? "");
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  for (const [re, to] of KEEP_PREFIX) out = out.replace(re, to);
  return out;
}

// ---------------------------------------------------------------- transcript
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

// Lines that look like user turns but are really harness output.
const NOT_A_REQUEST = /^(<[a-z-]+[\s>]|Caveat:|This session is being continued|\[Request interrupted)/;

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

export function readTranscript(file, { requests = 8 } = {}) {
  const asks = [];
  const files = [];
  let lastReply = "";
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { requests: [], lastReply: "", files: [] };
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.isMeta || e.isCompactSummary) continue;
    const msg = e.message || {};
    if (e.type === "user") {
      const t = textOf(msg.content).trim();
      if (t && !NOT_A_REQUEST.test(t)) asks.push(t);
    } else if (e.type === "assistant") {
      const t = textOf(msg.content).trim();
      if (t) lastReply = t;
      if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (p?.type !== "tool_use" || !EDIT_TOOLS.has(p.name)) continue;
          const f = p.input?.file_path || p.input?.notebook_path;
          if (typeof f === "string" && f) files.push(f);
        }
      }
    }
  }
  const uniq = [...new Set(files.reverse())].slice(0, 20).reverse();
  return { requests: asks.slice(-requests), lastReply, files: uniq };
}

// ---------------------------------------------------------------- notebooks
function clip(s, n) {
  s = String(s).trim();
  return s.length <= n ? s : s.slice(0, n) + " […]";
}

export function template(sessionId, firstRequest = "") {
  const title = firstRequest ? clip(firstRequest.split("\n")[0], 80) : "untitled task";
  return [
    `# ${title}`,
    "",
    `Session \`${shortId(sessionId)}\` · started ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    "",
    "## Goal (in the user's words)",
    "",
    "## Files, links, commands",
    "",
    "## Done",
    "",
    "## Next",
    "",
    "## Decisions",
    "",
    "## Gotchas",
    "",
  ].join("\n");
}

function stripAuto(text) {
  const i = text.indexOf(AUTO_START);
  return i === -1 ? text : text.slice(0, i).trimEnd() + "\n";
}

export function autoSection({ requests, lastReply, files }, { trigger = "auto", transcript = "" } = {}) {
  const out = [
    AUTO_START,
    `## Before compaction (${new Date().toISOString().slice(0, 16).replace("T", " ")}, ${trigger})`,
    "_Written by the PreCompact hook and replaced on every compaction. The sections above are the real state._",
    "",
  ];
  if (requests.length) {
    out.push(`### Last ${requests.length} user requests (oldest first)`);
    requests.forEach((r, i) => out.push(`${i + 1}. ${redact(clip(r, 600)).replace(/\n/g, "\n   ")}`));
    out.push("");
  }
  if (files.length) {
    out.push("### Files edited this session");
    files.forEach((f) => out.push(`- ${f}`));
    out.push("");
  }
  if (lastReply) out.push("### Last assistant reply", redact(clip(lastReply, 2500)), "");
  if (transcript) out.push(`Transcript: ${transcript}`);
  out.push(AUTO_END);
  return out.join("\n");
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function listOpen(cwd, { exceptId, cfg = config(), now = Date.now() } = {}) {
  const dir = notebookDir(cwd, cfg);
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
  const cutoff = now - cfg.openDays * 86400_000;
  return names
    .map((n) => {
      const file = path.join(dir, n);
      const st = fs.statSync(file);
      const first = fs.readFileSync(file, "utf8").split("\n").find((l) => l.trim()) || n;
      return { id: n.slice(0, -3), file, mtime: st.mtimeMs, title: first.replace(/^#+\s*/, "").trim() };
    })
    .filter((n) => n.id !== shortId(exceptId) && n.mtime >= cutoff)
    .sort((a, b) => b.mtime - a.mtime);
}

// ---------------------------------------------------------------- hooks
export function onSessionStart(input, cfg = config()) {
  const source = input.source || "startup";
  const cwd = input.cwd || process.cwd();
  const file = notebookPath(cwd, input.session_id, cfg);
  const parts = [];

  if (source === "compact" || source === "resume" || source === "clear") {
    if (fs.existsSync(file)) {
      let text = fs.readFileSync(file, "utf8");
      if (text.length > cfg.maxChars) text = text.slice(0, cfg.maxChars) + `\n[notebook truncated, read ${file} for the rest]`;
      parts.push(
        `CONTEXT RESTORE (${source}). This session's working notebook is ${file}.\n` +
          "If it disagrees with the summary, the notebook is newer. Read it and continue from it.\n\n" +
          text,
      );
    } else if (cfg.nudge) {
      parts.push(
        `Context was refreshed (${source}) and this session has no notebook yet. ` +
          `If a multi-step task is in progress, create ${file} now and keep it updated.`,
      );
    }
    if (input.transcript_path) parts.push(`Full transcript, for narrow searches only: ${input.transcript_path}`);
  } else {
    if (cfg.nudge) {
      parts.push(
        `Working notebook for this session: ${file}\n` +
          "For any task longer than a few steps, create it first (sections: Goal in the user's words, " +
          "Files/links/commands, Done, Next, Decisions, Gotchas) and update it after each meaningful step " +
          "(a file shipped, a test passed, a decision made). Anything only in the chat may be lost when the " +
          "context is compacted; the notebook is restored automatically. Never write secrets into it.",
      );
    }
    const open = listOpen(cwd, { exceptId: input.session_id, cfg });
    if (open.length) {
      const lines = open
        .slice(0, 10)
        .map((n) => `- ${n.id}.md: ${clip(n.title, 90)} (updated ${new Date(n.mtime).toISOString().slice(0, 16).replace("T", " ")})`);
      parts.push(
        `Open notebooks from other sessions in this project (last ${cfg.openDays} days). ` +
          "If the user wants to continue one of them, read that file first:\n" +
          lines.join("\n"),
      );
    }
  }
  if (!parts.length) return {};
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: parts.join("\n\n") } };
}

export function onPreCompact(input, cfg = config()) {
  if (!input.session_id || !input.transcript_path) return {};
  const t = readTranscript(input.transcript_path, { requests: cfg.requests });
  if (!t.requests.length && !t.lastReply) return {};
  const file = notebookPath(input.cwd || process.cwd(), input.session_id, cfg);
  const base = fs.existsSync(file)
    ? stripAuto(fs.readFileSync(file, "utf8"))
    : template(input.session_id, redact(t.requests[0] || ""));
  writeAtomic(file, base.trimEnd() + "\n\n" + autoSection(t, { trigger: input.trigger, transcript: input.transcript_path }) + "\n");
  return {};
}

export function archive(cwd, id, cfg = config()) {
  const file = notebookPath(cwd, id, cfg);
  if (!fs.existsSync(file)) return null;
  const dest = path.join(notebookDir(cwd, cfg), "archive", `${new Date().toISOString().slice(0, 10)}-${shortId(id)}.md`);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.renameSync(file, dest);
  return dest;
}
