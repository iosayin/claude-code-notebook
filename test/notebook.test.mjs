import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AUTO_START,
  config,
  notebookPath,
  onPreCompact,
  onSessionStart,
  readTranscript,
  redact,
  archive,
} from "../src/notebook.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccn-"));
  const cfg = config({ CLAUDE_NOTEBOOK_DIR: path.join(root, "notebooks") });
  return { root, cfg };
}

function transcript(root, entries) {
  const file = path.join(root, "t.jsonl");
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

const user = (text) => ({ type: "user", message: { role: "user", content: text } });
const assistant = (content) => ({ type: "assistant", message: { role: "assistant", content } });

test("redact masks common secret shapes and keeps the surrounding text", () => {
  const s = [
    "key sk-ant-api03-AAAAAAAAAAAAAAAAAAAA here",
    "gh ghp_abcdefghijklmnopqrstuvwxyz0123",
    "export API_TOKEN=supersecretvalue",
    "curl -H 'Authorization: Bearer abcdefghijklmnop1234'",
    "db postgres://app:hunter22@db.example.com/x",
    "aws AKIAABCDEFGHIJKLMNOP",
  ].join("\n");
  const out = redact(s);
  for (const leak of ["sk-ant-api03", "ghp_abc", "supersecretvalue", "abcdefghijklmnop1234", "hunter22", "AKIAABCDEFGHIJKLMNOP"]) {
    assert.ok(!out.includes(leak), `leaked: ${leak}\n${out}`);
  }
  assert.match(out, /API_TOKEN=\[redacted\]/);
  assert.match(out, /Bearer \[redacted\]/);
  assert.match(out, /postgres:\/\/\[redacted\]@db\.example\.com/);
  assert.equal(redact("nothing secret in here"), "nothing secret in here");
});

test("readTranscript keeps real requests, last reply and edited files", () => {
  const { root } = sandbox();
  const file = transcript(root, [
    user("Add a dark mode toggle"),
    user("<command-name>/clear</command-name>"),
    { type: "user", isMeta: true, message: { content: "meta" } },
    assistant([
      { type: "text", text: "Working on it" },
      { type: "tool_use", name: "Edit", input: { file_path: "/app/src/theme.ts" } },
      { type: "tool_use", name: "Bash", input: { command: "npm test" } },
    ]),
    user([{ type: "tool_result", content: "ok" }]),
    user("Also persist it"),
    assistant([{ type: "text", text: "Done, saved to localStorage." }]),
    "not json",
  ]);
  fs.appendFileSync(file, "{broken\n");
  const t = readTranscript(file, { requests: 8 });
  assert.deepEqual(t.requests, ["Add a dark mode toggle", "Also persist it"]);
  assert.equal(t.lastReply, "Done, saved to localStorage.");
  assert.deepEqual(t.files, ["/app/src/theme.ts"]);
  assert.deepEqual(readTranscript(path.join(root, "missing.jsonl")), { requests: [], lastReply: "", files: [] });
});

test("pre-compact creates a notebook, then replaces only its own section", () => {
  const { root, cfg } = sandbox();
  const t = transcript(root, [user("Migrate the API to v2, token sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZ"), assistant("Step 1 done")]);
  const input = { session_id: "abcd1234-ffff", transcript_path: t, cwd: "/work/shop", trigger: "auto" };
  onPreCompact(input, cfg);
  const file = notebookPath("/work/shop", "abcd1234-ffff", cfg);
  let text = fs.readFileSync(file, "utf8");
  assert.match(text, /^# Migrate the API to v2/);
  assert.ok(!text.includes("ZZZZZZZZ"), "secret written to disk");
  assert.equal(text.split(AUTO_START).length, 2);

  // The agent writes its own notes; a second compaction must keep them.
  fs.writeFileSync(file, text.replace("## Done\n", "## Done\n- schema migrated\n"));
  onPreCompact(input, cfg);
  text = fs.readFileSync(file, "utf8");
  assert.match(text, /- schema migrated/);
  assert.equal(text.split(AUTO_START).length, 2, "auto section duplicated");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("session-start restores the notebook after compaction", () => {
  const { cfg } = sandbox();
  const file = notebookPath("/work/shop", "abcd1234", cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "# Migrate API\n\n## Next\n- run backfill\n");
  const out = onSessionStart({ session_id: "abcd1234", source: "compact", cwd: "/work/shop", transcript_path: "/t.jsonl" }, cfg);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(ctx, /CONTEXT RESTORE \(compact\)/);
  assert.match(ctx, /run backfill/);
  assert.match(ctx, /\/t\.jsonl/);
});

test("session-start truncates very large notebooks", () => {
  const { cfg } = sandbox();
  const small = { ...cfg, maxChars: 100 };
  const file = notebookPath("/w", "s1", small);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x".repeat(5000));
  const ctx = onSessionStart({ session_id: "s1", source: "resume", cwd: "/w" }, small).hookSpecificOutput.additionalContext;
  assert.ok(ctx.length < 1000);
  assert.match(ctx, /truncated/);
});

test("startup points to the notebook path and lists other open notebooks", () => {
  const { cfg } = sandbox();
  const other = notebookPath("/w", "other111", cfg);
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, "# Fix flaky checkout test\n");
  const old = notebookPath("/w", "old22222", cfg);
  fs.writeFileSync(old, "# Ancient task\n");
  const tenDaysAgo = new Date(Date.now() - 10 * 86400_000);
  fs.utimesSync(old, tenDaysAgo, tenDaysAgo);

  const ctx = onSessionStart({ session_id: "new33333", source: "startup", cwd: "/w" }, cfg).hookSpecificOutput.additionalContext;
  assert.match(ctx, /new33333\.md/);
  assert.match(ctx, /Fix flaky checkout test/);
  assert.ok(!ctx.includes("Ancient task"));

  const quiet = { ...cfg, nudge: false };
  assert.deepEqual(onSessionStart({ session_id: "x", source: "startup", cwd: "/empty" }, quiet), {});
});

test("archive moves a finished notebook out of the open list", () => {
  const { cfg } = sandbox();
  const file = notebookPath("/w", "done4444", cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "# Finished\n");
  const dest = archive("/w", "done4444", cfg);
  assert.ok(dest.includes(`${path.sep}archive${path.sep}`));
  assert.ok(!fs.existsSync(file));
  assert.equal(archive("/w", "nope", cfg), null);
});

test("cli hook never fails, even on garbage input", () => {
  for (const name of ["session-start", "pre-compact", "unknown"]) {
    const out = execFileSync("node", [CLI, "hook", name], { input: "not json", encoding: "utf8" });
    assert.doesNotThrow(() => JSON.parse(out));
  }
});

test("cli install is idempotent and uninstall leaves other hooks alone", () => {
  const { root } = sandbox();
  const home = path.join(root, "home");
  const settings = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const mine = { matcher: "", hooks: [{ type: "command", command: "echo mine" }] };
  fs.writeFileSync(settings, JSON.stringify({ model: "x", hooks: { SessionStart: [mine] } }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  execFileSync("node", [CLI, "install"], { env });
  execFileSync("node", [CLI, "install"], { env });
  let s = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.equal(s.model, "x");
  assert.equal(s.hooks.SessionStart.length, 2);
  assert.equal(s.hooks.PreCompact.length, 1);
  assert.ok(fs.existsSync(path.join(home, ".claude", "claude-code-notebook", "cli.mjs")));

  execFileSync("node", [CLI, "uninstall"], { env });
  s = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.deepEqual(s.hooks, { SessionStart: [mine] });
});
