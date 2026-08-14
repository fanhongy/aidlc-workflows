# Troubleshooting

This chapter covers common issues and their solutions, organized by symptom.

> **Harness note.** Symptoms and fixes below are written for **Claude Code** (hook
> filenames, `settings.json` blocks, compaction behaviour). The deterministic core
> — state, audit, the engine — behaves identically on every harness, but the
> shell-level surfaces differ: the other harnesses wire hooks and config their own way
> (see [Running on other harnesses](harnesses/README.md)). Where a fix names a
> `.claude/` path or a Claude mechanic, the equivalent lives in your harness's
> config dir.

---

## Quick Fix Table

| Symptom | Quick Fix |
|---------|-----------|
| No audit entries appearing | Run `aidlc doctor`; for a copy install, also verify `bun` is on the hook PATH |
| State file corrupted | Run `/aidlc --doctor`, compare against state template |
| Stuck at approval gate | Type your response; use `/aidlc --stage <target>` to jump past it |
| Context compacted mid-session | Run `/aidlc` to resume from checkpoint |
| Audit log too large | Rename to `audit-YYYY-MM.md`; a fresh one is created automatically |
| Hooks appear to hang | Remove stale lock dirs from system temp directory (see below) |
| Statusline shows "ready" | Check `aidlc-state.md` has a `**Lifecycle Phase**` field |
| Statusline not appearing | Run `aidlc doctor`; for a copy install, verify `bun` is on PATH |
| Subagent timed out | Run `/aidlc` to retry or run the stage inline |
| Workflow stuck or misbehaving, need help | Run `/aidlc --doctor --export` and share the produced `.tar.gz` (redacted; no work product) |

---

## Native Install Channel

| Symptom or error | Resolution |
|------------------|------------|
| `Checksum mismatch for <asset>.` or `<asset>: checksum mismatch` | Stop. Do not reuse the downloaded directory. Download the complete release asset set and `checksums.txt` again from the same immutable release. |
| `command not found: aidlc` after `install.sh` | Add the installer-reported bin directory to `PATH` (normally `export PATH="$HOME/.local/bin:$PATH"`), open a new shell, and run `aidlc doctor`. |
| `--offline requires --from <release-directory>` | Offline mode never falls back to a network release. Transfer the complete release asset set, then pass its directory with `--from` / `-From`; the installer verifies it. |
| `aidlc.cmd` exits 4 or the Windows active pointer is invalid | Do not edit `%LOCALAPPDATA%\aidlc\active-executable`. Rerun the same verified installer or use `aidlc use <version>` from a working retained executable. |
| `pending Windows uninstall` or a Windows uninstall recovery failure | Close active AI-DLC commands and run `aidlc doctor`. A valid continuation resumes on the next command; do not delete its temp journal, cleanup script, or machine fence independently. |
| `refusing to refresh while ... workflow(s) are active` | Complete every named workflow, including parked workflows, then rerun `aidlc config`. `--force`, `--yes`, and a plan token cannot bypass this guard. `update` or `use` may proceed because they do not modify projects. |
| `config plan changed after approval` | Rerun `aidlc config --dry-run --json`, review `data.actions`, and apply the new `data.planToken` with exactly the same source and behavior options. |
| `locally modified` or `managed block was locally modified` from `aidlc config` | Run `aidlc config --dry-run --json` and review `data.actions`. Use `--force` only to replace baseline-owned framework bytes or managed blocks; it never authorizes unrelated root content. |
| `unowned whole file` from `aidlc config` | Move or merge the existing file manually before config. Whole-file integrations such as OpenCode's `opencode.json` cannot be claimed with `--force`. |
| `legacy root integration ambiguous; move or delete the unmarked AI-DLC content` | Move or delete the old unmarked AI-DLC block in the named root file, preserve any project-owned text elsewhere, then rerun `aidlc config`. This release intentionally refuses to guess ownership. |
| `managed markers are missing, duplicated, or malformed` | Repair the named root file so it has exactly one matching `BEGIN AI-DLC` / `END AI-DLC` pair, or remove the broken AI-DLC block and rerun `aidlc config`. |
| `project runtime <version> is incompatible with selected engine <version>` | Run `aidlc use <version>` to install and select the compatible version, or refresh the project intentionally with `aidlc config`. |
| `this project requires <version>, which is not installed completely` | Install and register the exact strict-semver pin with `aidlc config --pin <version>`. Use `aidlc config --unpin` only when the team intends to stop pinning the project. |
| An update was interrupted and `aidlc version` still shows the prior release | This is the safe restored state: the old command remains active. Run `aidlc doctor`, then rerun the same `aidlc update --version <version>` command. |
| `another AI-DLC mutation holds .../.aidlc-transaction.lock` | Let the active init/lifecycle command finish. If its process no longer exists, rerun the command; stale owner-private staging is swept only after the lock is safely reclaimed. |
| `existing aidlc is managed by Homebrew` / `Nix`, or the destination command is `not owned by the AI-DLC installer` | Upgrade through the reported owner. To keep a separate native install, set `AIDLC_BIN_DIR` explicitly to an empty user-owned directory. This release does not itself ship Homebrew or Nix packaging and never replaces a mixed-ownership command. |
| `update cache is invalid` or machine config is rejected | Run `aidlc system config global list`. Repair or remove only the named `%LOCALAPPDATA%\aidlc\config.json` (Windows) or `${XDG_DATA_HOME:-$HOME/.local/share}/aidlc/config.json` (macOS/Linux); unknown keys and stored credentials are rejected. |
| `HTTPS_PROXY must use HTTP or HTTPS` or a release URL is rejected | Use an HTTP(S) proxy URL and an HTTPS release mirror without credentials, query, or fragment. The native client reads `HTTPS_PROXY` and `NO_PROXY`, not `HTTP_PROXY`, and redacts secret-like URL parts in errors. |
| Download fails behind a corporate CA | Pass `--ca-bundle <absolute-path>` or set `AIDLC_CA_BUNDLE`. The Windows bootstrap requires `curl.exe` when a custom CA is supplied. |
| `host inventory unavailable` from a plugin command | Run sync from a host session that injects the current plugin root, or restore the Claude/Codex host registry. Missing or malformed inventory is never treated as proof that content is safe to prune. |
| `cannot prune <plugin>: owned path changed since composition` | Preserve and review the local edit. Reconcile it with the plugin source before retrying; `--yes` does not override ownership hashes. |
| `aidlc system versions prune`, `uninstall`, or plugin prune requires `--yes` | The command is running without an interactive stdin. Review the listed removals, then rerun with `--yes`; integrity refusals cannot be bypassed. |
| `aidlc setup` is unknown, or an npm install is unavailable | Those channels are planned but not shipped. Use the release installer plus `aidlc config`; do not treat proposal transcripts as available commands. |

Native `aidlc doctor` also checks the active command pointer, rollback
eligibility, retained pin completeness, stale pin registrations, abandoned
transaction staging, project version skew, and whether binary-channel host
hooks and permission/trust entries consistently select the native command.

---

## Hooks Not Firing

**Symptom**: No entries appearing in the intent's `audit/` shards after file writes, or no subagent completion logs.

### Native channel versus copy-channel Bun

Native projects route all 17 hook sources through the self-contained `aidlc`
binary and do not require Bun. Run `aidlc doctor` to verify the active command
pointer and native host wiring.

Copied `dist/<harness>/` projects still execute the TypeScript hook files with
Bun. If Bun is missing from the PATH seen by non-interactive host processes,
those hooks do not fire. The roster includes mint-presence, dispatch-rules,
state-transition, reviewer-scope, review-freeze, plan-approval, audit, sensor,
runtime compile, token-usage fold, subagent, stop, state validation, statusline
sync, session start/end, and the statusline command.

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Windows
npm install -g bun
# or: powershell -c "irm bun.sh/install.ps1 | iex"

# Verify
bun --version
```

For a copy install, ensure `bun` is on the PATH inherited by the host, such as
`~/.zshenv` for zsh or `~/.bashrc` for bash and Git Bash, not only an
interactive-shell file. On native Windows PowerShell, the system PATH entry
set by `npm install -g bun` is sufficient.

### Reviewer tool calls refused ("reviewer read-scope: ...")

During a per-unit Construction review, the reviewer-scope hook refuses the dispatched reviewer's tool calls that reach into sibling units' `construction/` paths (the stage-protocol §12a read-scope bound); the refusal message names the scoped unit and the passed contract paths, and each refusal records a `REVIEWER_SCOPE_BLOCKED` audit row. If your own source tree contains a `construction/` directory unrelated to AI-DLC units (so legitimate reviewer reads are being refused), set `AIDLC_DISABLE_REVIEWER_SCOPE_HOOK=1` to disable enforcement; the prose bound still governs. A reviewer being refused with NO review in flight means a stale dispatch record - check `/aidlc --doctor`'s hook-drop counters (`reviewer-scope.drops`) and delete `<record>/.aidlc-reviewer-dispatch.json` if present (records older than 6 hours are ignored and cleaned automatically).

### Hook not configured

Hooks are registered project-wide in the harness's native configuration. On
Claude, verify that `.claude/settings.json` contains the expected `hooks`
events and `statusLine`. For a native project, complete active workflows and
run `aidlc config` to reconcile framework-owned wiring. For a copy install,
re-copy the complete current `dist/<harness>/` projection while preserving
project root integrations; do not patch one hook command in isolation.

---

## State File Issues

**Symptom**: Orchestrator reports corrupted state, or workflow behaves unexpectedly.

### State file missing

The state file is created during Initialization or when a scope is provided to `/aidlc`.

- Run `/aidlc --status` to confirm no workflow is active
- Run `/aidlc` or `/aidlc <scope>` to start a fresh workflow

### State file corrupted

The `validate-state.ts` hook checks for two required sections on every compaction: `## Stage Progress` and `## Current Status`. To repair:

1. Run `/aidlc --doctor` and address any reported state, graph, or hook issues
2. If the generated Stage Progress rows are stale, re-run the engine path that owns state resync: start or resume the workflow with `/aidlc`, or change scope through `/aidlc --scope <scope>` so the compiled graph and scope grid are reapplied
3. Use `.claude/knowledge/aidlc-shared/state-template.md` only as the section and field contract; do not restore stage rows by hand from the template

---

## Dispatched Stage Timeouts

**Symptom**: A dispatched stage (Reverse Engineering, Practices Discovery, User Stories, or Code Generation) returns errors or truncated output.

### What happens

The framework follows a built-in retry protocol:

1. **Automatic retry** with a reduced-context prompt
2. **If retry fails**, two options:
   - **Run inline** — execute the stage directly in the main conversation (no subagent boundary)
   - **Skip and revisit** — mark the stage incomplete and return later

### Manual recovery

Re-run `/aidlc` — it detects the `[-]` (in-progress) state and offers to resume or redo the stage. Check the `audit/` shards for the error entry to understand what failed.

---

## Approval Gate Stuck

**Symptom**: The workflow is waiting for your response at an approval gate.

### How to proceed

Type your response when prompted. Options are:

- **Approve** — continue to the next stage
- **Request Changes** — provide feedback for revision

### Revision loop escape hatch

After 3 revision cycles on the same stage, a third option appears: **Accept as-is**. This archives the current version and moves on.

### Skipping a stage

Use `/aidlc --stage <target>` to jump to a different stage. Intervening stages will be marked `[S]` (skipped) in the state file.

---

## Context Compaction

**Symptom**: Claude Code summarized earlier conversation context. The session may feel like it "forgot" recent discussion.

### What is preserved

All record-dir artifacts, `aidlc-state.md`, the `audit/` shards, and `.aidlc-recovery.md` persist on disk. Only in-memory conversation context and partial in-progress work not yet written to files is lost.

### How to recover

Run `/aidlc` after compaction. The framework:

1. Reads `aidlc-state.md` to load workflow position
2. Compares `.aidlc-recovery.md` against the state file — warns if they differ
3. Offers four resume options

If the recovery breadcrumb warns about a mismatch, choose **Redo current stage** to safely re-execute the stage that was in progress during compaction.

---

## Audit Log Growing Too Large

**Symptom**: this clone's audit shard has grown to thousands of lines over a long project.

### How to archive

```bash
# from the intent's record dir; <host>-<clone>.md is this clone's shard
mv audit/<host>-<clone>.md audit-archive/<host>-<clone>-2026-02.md
```

The next `/aidlc` invocation (or any hook-triggered write) creates a fresh shard. All audit content is safe to archive — the engine does not read the `audit/` shards for routing decisions.

### Git considerations

The `audit/` shards are committed (not gitignored) — see [What to Commit vs. Gitignore](14-artifacts-reference.md#what-to-commit-vs-gitignore). Each clone writes its own `<host>-<clone>.md` shard, so concurrent appends never merge-conflict; consider archiving (see above) before commits to keep diffs manageable.

---

## Lock Files Left Behind

**Symptom**: Hooks appear to hang briefly then skip. Subsequent audit entries are not written.

The audit hooks use `mkdir`-based locking (via `lib.ts`) to prevent concurrent writes. If a hook is interrupted, the lock directory may persist. Lock files are created in the system temp directory (`os.tmpdir()` -- typically `/tmp/` on macOS/Linux, `%TEMP%` on Windows).

### Finding stale locks

```bash
# macOS / Linux
ls -la /tmp/.aidlc-*

# Windows (PowerShell)
Get-ChildItem $env:TEMP -Filter ".aidlc-*"
```

Lock directories are named `.aidlc-audit-<hash>.lock` and `.aidlc-subagent-<hash>.lock` inside the system temp directory.

### Clearing stale locks

```bash
# macOS / Linux
rm -rf /tmp/.aidlc-audit-*.lock /tmp/.aidlc-subagent-*.lock

# Windows (PowerShell)
Remove-Item "$env:TEMP\.aidlc-audit-*.lock", "$env:TEMP\.aidlc-subagent-*.lock" -Recurse -Force
```

Safe to run at any time when no AI-DLC workflow is actively executing. Locks are transient and recreated on each hook invocation.

---

## Statusline Issues

### Shows "ready" when workflow is active

The statusline reads the `**Lifecycle Phase**` field from `aidlc-state.md`. If that field is missing or empty, it falls back to `[AIDLC] ready`.

**Fix:** Run `/aidlc --doctor` to check state file integrity. Verify the `## Current Status` section contains a `**Lifecycle Phase**` entry.

### Shows stale data

Expected behavior — the statusline updates when the state file is next written, typically at stage transitions.

### Not appearing at all

1. Run `aidlc doctor` and repair the reported native command or host wiring.
2. On a copy install, verify Bun is on the host process PATH.
3. On Claude, verify the `.claude/settings.json` `statusLine` entry exists.
4. With no state file, `[AIDLC] ready` is the expected output.

---

## Using `--doctor`

The `--doctor` utility command validates your setup. Run it whenever something seems wrong:

```
/aidlc --doctor
```

It checks the self-contained runtime (or Bun for a copy install), all 17
framework hooks wired by the host, project structure, workspace shell,
state/audit consistency, hook heartbeats, active command and rollback pointers,
project pins and version skew, transaction recovery, update cache, plugin
composition, graph integrity, scope and stage schemas, graph references, and
keyword overlap. Passing advisory rows include **Rule drift**, **Paired sensor
coverage**, uncommitted workspace records, and, when `repos.json` exists,
declared-repo and managed-`.gitignore` drift. A `[degraded]` hook-drop row fails
doctor; an `[advisory]` row remains passing. Exit is 0 on full pass, 1 on failed
checks, or 2 for invalid machine configuration. The report writes to stdout.
Doctor is read-only except for an explicitly allowed update-cache refresh and,
once an intent exists, its normal health-check audit rows.

When a workflow has issues, `--doctor` also prints a **Workflow diagnosis** section listing structured findings (unresolved gates, a stale or missing runtime graph, cold hooks, and similar "it will not advance" causes) — the same analysis `--doctor --export` writes to its report.

See [CLI Commands](12-cli-commands.md#aidlc-doctor-health-check) for full details on what each check validates and how to fix failures.

---

## Sharing a Diagnostic Report

When a workflow is stuck or misbehaving — a gate that will not open, a stage that
will not advance, an approved report repeatedly refused — and you want a
maintainer to look, run:

```
/aidlc --doctor --export
```

This runs a fresh `--doctor` pass, then writes a small, **redacted** diagnostic
report to `aidlc/diagnostics/` (override with `--output <dir>`). It packages
a timestamped `.tar.gz` when a system `tar` is available; otherwise it keeps the
report directory and tells you to compress it yourself. Share that archive (or
directory) — it carries the diagnosis and redacted evidence, **not your work
product**. No workspace source, raw state/audit/runtime-graph files, or
artifact/contribution/question/memory bodies are included; paths are normalized,
intent ids are hashed, and secret-like values are scrubbed.

The report reconstructs the workflow timeline from the audit trail and runs
deterministic condition→remedy rules. The two most common causes it catches:

- **Unresolved approval gates** — a stage whose gate never resolved is the single
  most common "it will not advance" cause.
- **Stale or missing runtime graph / cold hooks** — a runtime graph older than its
  authored inputs (or absent), or a hook that has not fired in a long time,
  points at a recompile that did not run.

`report.md` inside the report lists every finding with a remedy; a remedy that
names a recovery bypass (such as an `AIDLC_DISABLE_*` env var) is flagged
as not safe to automate. See [CLI Commands](12-cli-commands.md#aidlc-doctor-export-write-a-diagnostic-report)
for the full report contents and safety model.

---

## Next Steps

- [State Tracking and Audit Trail](10-state-and-audit.md) — State file structure
- [Session Management](11-session-management.md) — Resume options after compaction
- [CLI Commands](12-cli-commands.md) — `--doctor`, `--status`, `--stage` usage
- [Glossary](glossary.md) — Definitions for compaction, recovery breadcrumb, hook
