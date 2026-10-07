# claude-code-notebook

[![npm](https://img.shields.io/npm/v/claude-code-notebook?color=cb3837&logo=npm)](https://www.npmjs.com/package/claude-code-notebook) [![test](https://github.com/iosayin/claude-code-notebook/actions/workflows/test.yml/badge.svg)](https://github.com/iosayin/claude-code-notebook/actions/workflows/test.yml) [![license](https://img.shields.io/github/license/iosayin/claude-code-notebook)](LICENSE) ![node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white) ![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

**Claude Code forgets what it was doing after the context is compacted. This fixes that.**

Two hours into a task, the context fills up and gets compacted. The summary keeps the big picture but drops the details: the file you agreed not to touch, the command that finally worked, the decision you made an hour ago, what was next. Claude carries on with a confident, slightly wrong idea of where you were.

`claude-code-notebook` gives every session a small Markdown notebook and two hooks:

- **Before compaction** it saves your last requests, the files edited and Claude's last reply into the notebook (secrets masked).
- **After compaction or resume** it puts the whole notebook back into Claude's context, so work continues from what was written down, not from what the summary remembered.
- **At startup** it tells Claude where the notebook is and asks it to keep it updated, and lists notebooks other sessions left open in the same project.

<p align="center"><img src="https://raw.githubusercontent.com/iosayin/claude-code-notebook/main/docs/demo.gif" width="720" alt="Before and after: Claude Code continues from its notebook after compaction"></p>

## Install

```bash
npx claude-code-notebook install
```

Restart Claude Code. That's it.

- Adds a `SessionStart` and a `PreCompact` hook to `~/.claude/settings.json` (backup kept as `settings.json.bak`). Your other hooks are left alone.
- `--project` writes `./.claude/settings.json` instead, `--dry-run` shows the change and writes nothing.
- The hooks run a local copy in `~/.claude/claude-code-notebook/`, so there is no `npx` call (and no network) on every session.
- `npx claude-code-notebook uninstall` removes the hooks. Notebooks stay where they are.

## What a notebook looks like

Notebooks live in `~/.claude/notebooks/<project>/<session>.md`, outside your repo, so nothing ends up in git by accident.

```markdown
# Migrate checkout to the new payments API

Session `3f9c2a1b` · started 2026-03-14 10:02

## Goal (in the user's words)
"Move checkout to v2 without touching the refund flow, staging first."

## Files, links, commands
- src/checkout/client.ts, src/checkout/webhooks.ts
- `npm run test:checkout -- --grep v2`

## Done
- client switched to v2, tests green

## Next
- webhook signature check (v2 uses a different header)

## Decisions
- keep v1 client behind a flag until staging has run a week

## Gotchas
- sandbox rejects amounts under 0.50

<!-- notebook:auto -->
## Before compaction (2026-03-14 12:41, auto)
### Last 8 user requests (oldest first)
...
### Files edited this session
...
<!-- /notebook:auto -->
```

Claude writes the sections at the top. The block at the bottom is written by the hook and replaced on every compaction, so the file does not grow forever.

## Commands

| Command | |
|---|---|
| `npx claude-code-notebook list` | open notebooks for the current folder |
| `npx claude-code-notebook done <id>` | move a finished notebook to `archive/` |
| `npx claude-code-notebook path` | print the notebook folder for the current folder |

## Settings

Environment variables, all optional:

| Variable | Default | |
|---|---|---|
| `CLAUDE_NOTEBOOK_DIR` | `~/.claude/notebooks` | where notebooks are kept |
| `CLAUDE_NOTEBOOK_MAX_CHARS` | `20000` | larger notebooks are truncated when restored (Claude is told the full path) |
| `CLAUDE_NOTEBOOK_REQUESTS` | `8` | user requests saved before compaction |
| `CLAUDE_NOTEBOOK_OPEN_DAYS` | `7` | how far back "open notebooks" are listed at startup |
| `CLAUDE_NOTEBOOK_NUDGE` | `on` | `off` = don't ask Claude to keep a notebook, only restore existing ones |

## Privacy and safety

- **Local only.** No network calls, no telemetry. The hooks read the transcript Claude Code already keeps on your disk and write Markdown next to it.
- **Secrets are masked** before anything is written: API keys (Anthropic, OpenAI, GitHub, GitLab, Slack, AWS, Google, npm), JWTs, bearer tokens, `PASSWORD=`/`TOKEN=` style assignments, private keys and credentials inside URLs. It's pattern-based, so don't paste production secrets into chats anyway.
- Notebooks are created with `0600` permissions, outside your repository.
- A hook that fails prints `{}` and exits 0. It can never block or break a session.

## How it works

Claude Code passes `session_id`, `transcript_path`, `cwd` and `source` (`startup`, `resume`, `clear`, `compact`) to `SessionStart` hooks and lets them add text to the context through `additionalContext`. `PreCompact` runs right before compaction. That's all this uses: about 400 lines of plain Node.js, no dependencies.

## FAQ

**Isn't this what `CLAUDE.md` is for?** `CLAUDE.md` is for things that are always true about a project. A notebook is the live state of one task: what's done, what's next, what you decided ten minutes ago.

**Does it cost tokens?** Only the notebook text that's restored (capped by `CLAUDE_NOTEBOOK_MAX_CHARS`). That's usually far less than re-explaining the task.

**Several sessions in the same repo?** Each session has its own notebook. At startup, Claude sees the titles of the others and can pick one up if you ask it to.

## License

MIT
