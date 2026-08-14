# Install and Lifecycle

The native release channel installs a self-contained `aidlc` command and one
or more harness runtimes. `aidlc config` then creates or refreshes a project from
that local runtime. The installer and config path do not require Bun, Node.js,
or Git.

This chapter describes the native install lifecycle available in this release.
The planned `aidlc setup` experience, npm package, and package-manager formulas
are not available yet. Existing copy installs remain supported and continue to
invoke the TypeScript tools with Bun.

## Install

Release assets cover:

- macOS x64 and arm64
- Linux x64 and arm64, with glibc and musl builds
- Windows x64

Install as the target user. The Unix installer refuses root; the Windows
installer refuses an elevated Administrator session. Native installs are
per-user and do not need `sudo`.

The installer includes `claude`, `kiro`, `kiro-ide`, `codex`, and `opencode`
together:

```bash
curl -fsSL https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.sh \
  | bash
```

### macOS and Linux

```bash
curl -fsSL https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.sh \
  | bash
export PATH="$HOME/.local/bin:$PATH"
```

An online run needs `curl` or `wget`; every run needs `sha256sum` or `shasum`.
It installs
versions under `${XDG_DATA_HOME:-$HOME/.local/share}/aidlc/versions/` and
links `$HOME/.local/bin/aidlc` to the active version by default.

The installer does not edit a shell startup file unless
`--profile <absolute-path-under-$HOME>` is explicit. That option writes or
updates one `BEGIN AI-DLC:PATH` block transactionally and preserves the rest
of the file.

### Windows PowerShell

```powershell
$installer = Join-Path $env:TEMP install-aidlc.ps1
irm https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.ps1 -OutFile $installer
& $installer
```

Windows installs versions under `%LOCALAPPDATA%\aidlc\versions\` and keeps a
stable `%LOCALAPPDATA%\aidlc\bin\aidlc.cmd` shim. The installer adds that bin
directory to the current PowerShell process and prints the command needed in
new sessions; it does not edit a PowerShell profile.

PowerShell installer parameters use their native names, such as `-Version`, `-From`, `-Offline`,
`-ReleaseBaseUrl`, `-CaBundle`, `-Yes`, `-Quiet`, `-Json`, and `-NoColor`.

### Automation

Installation asks no harness question. Human and non-interactive runs install
the same binary plus all harness runtimes.

### Installer Options

| Unix | PowerShell | Meaning |
|------|------------|---------|
| `--version <x.y.z>` | `-Version <x.y.z>` | Install one strict semantic version instead of latest |
| `--from <dir>` | `-From <dir>` | Read a flat release set locally and imply offline mode |
| `--offline` | `-Offline` | Forbid network access; requires `--from` / `-From` |
| `--release-base-url <url>` | `-ReleaseBaseUrl <url>` | Use a compatible release mirror |
| `--ca-bundle <absolute-path>` | `-CaBundle <absolute-path>` | Use a custom CA bundle |
| `--profile <absolute-path>` | Not available | Transactionally add the Unix PATH block |
| `--yes` | `-Yes` | Automation mode; it does not bypass integrity checks |
| `--quiet` | `-Quiet` | Suppress progress and emit one result line |
| `--json` | `-Json` | Suppress progress and emit one schema-versioned JSON result |
| `--no-color` | `-NoColor` | Disable color output |
| `--help` | Not exposed | Print Unix installer usage |

`AIDLC_RELEASE_BASE_URL` and `AIDLC_CA_BUNDLE` provide installer defaults;
explicit options win. `AIDLC_INSTALL_ROOT` and `AIDLC_BIN_DIR` override the
machine and command locations. Those paths must be absolute on Unix. The
PowerShell installer also honors `AIDLC_OFFLINE=1`; the Unix installer
requires the explicit `--offline` or `--from` spelling.

### Release Authentication

The installer:

1. Downloads or reads `version.json` and `checksums.txt`.
2. Verifies the `version.json` SHA-256 before trusting its asset metadata.
3. Verifies the selected binary and harness archives by SHA-256 and declared
   byte length.
4. Lets the verified binary validate and transactionally install the release.

Metadata is limited to 1 MiB and individual release assets to 1 GiB. Asset
names cannot contain paths. Archive extraction rejects links, special files,
path traversal, absolute paths, duplicate entries, and oversized expansion.

The release workflow re-verifies `checksums.txt` before publishing and
publishes a GitHub build-provenance attestation for the release artifacts.
TLS, SHA-256, and that provenance are the permanent trust model. OS
code-signing and notarization are not part of it.

The installer refuses an existing mixed-ownership command. It also yields to
an existing Homebrew or Nix command instead of replacing it. This project does
not yet ship those package-manager channels; use the owning manager or choose
an explicit empty `AIDLC_BIN_DIR`.

## Configure or Refresh a Project

Run config before opening the harness:

```bash
cd your-project
aidlc config --dry-run --json
aidlc config
aidlc doctor
```

`aidlc config` is local-only and transactional. It creates the selected harness
tree, the `aidlc/` workspace shell, root integrations, a projection stamp, and
an ownership baseline. It does not create a workflow intent.

### Config Options

| Option | Meaning |
|--------|---------|
| `--project-dir <path>` | Target this project instead of the current directory |
| `--harness <name>` | Select an installed harness runtime |
| `--from <dir-or-tgz>` | Use a local projection directory or projection archive instead of an installed runtime |
| `--mcp defaults\|none` | Add or omit Claude's optional shipped MCP entries |
| `--dry-run` | Calculate the complete plan without creating the target directory or changing bytes |
| `--plan-token <token>` | Apply only the exact plan approved from a JSON dry run |
| `--force` | Replace locally modified framework-owned files and managed blocks where that policy permits |
| `--yes` | Confirm an otherwise unrecognized target directory; it does not imply MCP consent or choose a harness |
| `--json` | Emit one result object with counts, actions, and `data.planToken` |
| `--quiet` | Emit one summary or remediation line |
| `--no-color` | Disable color output |

An existing project stamp fixes the harness for a refresh. A fresh interactive
project prompts for a harness; a non-interactive run requires `--harness`.
If `.aidlc-version` exists, config
requires a source at that exact version with the matching project harness.

Config recognizes directories containing `.git`, `package.json`, `Cargo.toml`,
`go.mod`, or `pyproject.toml`. Outside those shapes, interactive mode asks for
confirmation and non-interactive mode requires `--project-dir`.

Claude's optional MCP integration defaults to `none` without a TTY. A human
TTY is prompted when no prior choice exists. `--yes` and `--json` do not grant
MCP consent. Reliable automation supplies `--project-dir`, `--harness`, and
`--mcp defaults|none` explicitly; JSON controls output but does not disable
TTY prompts by itself.

For exact scripted approval:

```bash
token=$(
  aidlc config --project-dir "$PWD" --harness claude --mcp none \
    --dry-run --json | jq -r .data.planToken
)
aidlc config --project-dir "$PWD" --harness claude --mcp none \
  --plan-token "$token" --json
```

Use identical source and behavior options for both calls. Source bytes,
options, or project state changing after the preview changes the token and
the apply fails closed.

### Refresh Safety

A refresh changes project engine and graph files, so config refuses while any
workflow in any space is not complete. Parked workflows still count as
active. Complete every workflow named in the error, then rerun config.

The check runs once while planning and again under the workspace audit lock
immediately before commit. `--force`, `--yes`, and `--plan-token` do not bypass
it. `aidlc update` and `aidlc use` remain safe during a workflow because
they only change machine state.

Refresh preserves:

- all workspace records, audit shards, knowledge, and other project files
  absent from the shipped projection
- existing `aidlc/active-space` and space memory files, which are
  project-owned seeds
- every non-identity sibling key in mutable `tools/data/harness.json`,
  including plugin selection and future policy records
- plugin-composed files and recorded stage contributions, then regenerates
  graph, runner, scope, and compiled table surfaces
- upstream-authored orchestrator prose while rebuilding its compiled stage and
  scope regions from the preserved project composition

Locally modified framework-owned files conflict against the prior baseline.
`--force` replaces those files with the refreshed candidate, including local
edits to hand-authored orchestrator prose. It does not claim unrelated
project content.

### Root Integrations and Ownership

| Surface | Harnesses | Policy |
|---------|-----------|--------|
| `.gitignore` | All | Own one marked AI-DLC block; preserve every byte outside it |
| `.mcp.json` / `mcpServers` | Claude | Add or remove only consented, baseline-owned entries; preserve user keys and overrides |
| `AGENTS.md` | Kiro CLI, Kiro IDE, Codex, OpenCode | Own one marked onboarding block; preserve project instructions |
| `.vscode/settings.json` / `kiroAgent.trustedCommands` | Kiro IDE native channel | Reconcile only the shipped string entries; preserve other settings and values |
| `opencode.json` | OpenCode | Whole-file ownership; an unknown existing file is a conflict |

Known unmarked files and JSON entries from historical shipped projections are
adopted only when their exact recorded SHA-256 signature matches. Modified
lookalikes remain ambiguous and are refused.

`--force` can replace a modified, baseline-owned managed block or managed
harness file. It cannot adopt ambiguous unmarked content, overwrite a
user-owned JSON value, or replace an unowned or locally modified whole-file
integration such as `opencode.json`. Malformed JSON, malformed or duplicate
markers, non-regular-file targets, and retired owned content whose integrity
cannot be proved are hard conflicts.

Every planned path receives one action:

| Action | Meaning |
|--------|---------|
| `create` | Add an absent framework path |
| `update` | Refresh framework-owned bytes |
| `merge` | Reconcile a managed block, JSON map, or JSON array |
| `preserve` | Keep current or project-owned bytes |
| `remove` | Remove content previously owned by the baseline and retired upstream |
| `conflict` | Refuse because ownership or integrity cannot be proved |

Successful config prints the host-specific next step:

| Harness | Next step |
|---------|-----------|
| Claude Code | Open Claude Code and run `/aidlc --doctor` |
| Kiro CLI | Run `kiro-cli chat`, then `/aidlc --doctor` |
| Kiro IDE | Open the project in Kiro IDE, then run `/aidlc --doctor` |
| Codex CLI | Run `codex`, then `$aidlc --doctor` |
| OpenCode | Run `opencode`, then `/aidlc --doctor` |

## Update and Version Selection

| Command | Public options and behavior |
|---------|-----------------------------|
| `aidlc update` | Install latest with the complete all-harness runtime, then atomically activate. Accepts `--version <x.y.z>`, `--from <release-dir>`, `--release-base-url <url>`, `--ca-bundle <path>`, `--offline`, and `--dry-run`. |
| `aidlc update --check` | Refresh update metadata without installing. Returns 5 when behind, 0 when current, 3 when unavailable/offline, and 1 when checks are disabled. |
| `aidlc use <x.y.z>` | Install the exact version when it is not retained, then make it machine-active without changing project files. |
| `aidlc config --pin <x.y.z>` | Install the exact version when needed, then write `.aidlc-version` and register the project pin without changing the machine-active pointer. |
| `aidlc config --unpin` | Remove `.aidlc-version` and its machine-local registry entry. |

Update downloads and fully validates a candidate before changing the active
pointer. Failed updates automatically restore the prior consistent
installation. A successful update retains the prior active version and every
registered project pin, then prunes older unprotected versions automatically.
There is no public rollback or retained-version management command.

## Project Pins and CI

```bash
aidlc config --pin 2.5.45
git add .aidlc-version
```

`aidlc config --pin <version>` installs the version if needed, writes
`.aidlc-version`, and registers the real project path in machine-local
`pins.json`.

Commit `.aidlc-version`. Engine commands validate the exact retained binary
and project harness before loading project data, then re-execute that binary
when it differs from the active version. A missing or incomplete pin fails
closed with `aidlc config --pin <version>` remediation. Machine lifecycle commands use
the active binary; `doctor`, `config`, and `use` are never trapped behind a
broken pin.

A fresh clone or CI runner installs the committed version before config:

```bash
version=$(cat .aidlc-version)
curl -fsSL https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.sh \
  | bash --version "$version" --quiet --yes
aidlc config --project-dir "$PWD" --harness claude --mcp none --quiet
aidlc doctor --project-dir "$PWD" --quiet
```

## Harness Selection

Harness selection belongs to `aidlc config --harness <name>`. Machine-level
harness management is not a public command.

## Offline Packages

The release asset set is the offline package. Download one complete release on
a connected machine and transfer that directory unchanged:

```bash
gh release download v2.5.45 --repo awslabs/aidlc-workflows --dir ./aidlc-offline
```

Install on the disconnected machine:

```bash
bash ./aidlc-offline/install.sh \
  --from ./aidlc-offline --offline
```

```powershell
& .\aidlc-offline\install.ps1 `
  -From .\aidlc-offline -Offline
```

For native commands, `--offline`, `AIDLC_OFFLINE=1`, or global `offline=true`
prevents release sockets. A network operation without `--from` then fails
before mutation. Config, doctor, version, and uninstall are local regardless.

## Mirrors, Proxies, CAs, and Update Settings

Release settings resolve in explicit option, environment, machine-config,
default order:

| Setting | Environment | Machine config |
|---------|-------------|----------------|
| Offline | `AIDLC_OFFLINE=1` (`0` explicitly enables network) | `aidlc system config global set offline on` |
| Mirror | `AIDLC_RELEASE_BASE_URL` | `aidlc system config global set release-base-url <url>` |
| CA bundle | `AIDLC_CA_BUNDLE` | `aidlc system config global set ca-bundle <absolute-path>` |

Manage the four machine keys:

```bash
aidlc system config global list
aidlc system config global get update-check
aidlc system config global set update-check off
aidlc system config global set offline on
aidlc system config global set release-base-url https://mirror.example/releases
aidlc system config global set ca-bundle /absolute/path/corporate-ca.pem
aidlc system config global clear ca-bundle
```

The keys are `update-check`, `offline`, `release-base-url`, and `ca-bundle`.
Boolean values accept `true|false`, `on|off`, `1|0`, or `yes|no`.
`aidlc config <get|set|clear|list> ... --global` is equivalent.

Mirror base URLs must use HTTPS, except loopback HTTP for local testing, and
cannot contain credentials, a query, or a fragment. The native lifecycle
client follows at most five redirects; redirected URLs may contain a query but
still cannot contain credentials or a fragment. Its errors redact URL
credentials, queries, and fragments.

The native release client honors `HTTPS_PROXY` / `https_proxy` and
`NO_PROXY` / `no_proxy`; proxy URLs must use HTTP or HTTPS. It does not read
`HTTP_PROXY`. The bootstrap scripts delegate proxy behavior to `curl`,
`wget`, or `Invoke-WebRequest`. On Windows, a custom CA bundle requires
`curl.exe`.

Bare help and management listings never refresh the network. They may display
a valid cached update notice. Interactive human `aidlc doctor` may refresh
stale or absent metadata within 750 ms. Non-TTY, `--json`, and `--quiet`
doctor runs are cache-only unless `--check-updates` is explicit.
`doctor --check-updates` and `update --check` use a 15-second metadata
budget. The cache expires after 24 hours; a failed or regressing refresh does
not replace a valid cache. `update-check=off` disables even explicit refreshes
but does not prevent an explicit `aidlc update`.

## Plugins

`aidlc doctor` reports installed-versus-composed plugin state. Plugin changes
are project configuration and converge through `aidlc config`; there is no
separate public plugin command.

## Output, Automation, and Exit Codes

The public commands support human, `--quiet`, and `--json` output where
declared by the route registry. `--json` emits a schema-versioned result
with `ok`, `code`, `status`, `message`, and command-specific `data` when
available. `--quiet` emits one success line or remediation line. Download
progress appears only in human mode.

The native diagnostic form is
`aidlc doctor [--project-dir <path>] [--verbose] [--json|--quiet]
[--check-updates] [--release-base-url <url>] [--ca-bundle <path>]
[--offline]`. `--export` writes a redacted diagnostic bundle, with
`--output <directory>` overriding its default project location; export output
is additional to the selected live-report mode.

`--no-color` and `NO_COLOR` disable ANSI output. `--project-dir <path>` selects
project context without changing the shell directory. Destructive operations
such as `uninstall` prompt on a TTY and require `--yes` without one. `--yes` never bypasses
ownership, integrity, active-workflow, or release-authentication refusals.

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Operational failure |
| 2 | Usage or invalid machine configuration |
| 3 | Required network result or retained runtime unavailable |
| 4 | Integrity or ownership refusal |
| 5 | Check completed and action is required, such as an available update |

## Help and Completions

`aidlc --help` prints exactly the six public commands. `aidlc help --all`
reveals the hidden `engine` and `system` namespaces and points to
`aidlc engine --help` / `aidlc system --help` for their full inventories.
The installer places Bash, Zsh, Fish, and PowerShell files under the per-user AI-DLC data root's
`completions/` directory, generated from the public route registry; there is
no public completion-generation verb.

## Transactions and Recovery

Project and machine mutations stage on the destination filesystem, validate
the candidate, and commit through atomic renames. Concurrent changes detected
against planned state abort instead of overwriting new bytes. Abandoned
owner-private staging is swept only after lock and ownership checks.

If rollback of an interrupted commit cannot be completed safely, evidence is
retained in a named `.aidlc-recovery-*` quarantine under the machine install
root or project root. `aidlc doctor` reports it. Recover any needed files,
ensure no AI-DLC mutation is running, then remove only the listed directory
manually. Automatic staging cleanup never deletes quarantines.

Windows uninstall uses a recoverable continuation because a running executable
cannot remove its own command shim. A later command resumes a valid pending
continuation before doing other work.

## Copy Channel

Copying `dist/<harness>/` remains the source/development channel. Copy the
complete distribution root so the harness tree, `aidlc/` workspace shell, and
project-root files stay together. This channel still invokes
`bun <harness>/tools/aidlc.ts`; Bun must be on the PATH seen by hooks.

The separately generated `dist-release/<harness>/` trees are native release
payloads consumed through the installer and `aidlc config`, not replacements to
copy by hand. Prefer the public `aidlc` routes whenever the native command is
installed. Direct `bun .../tools/*.ts` calls remain copy-channel and developer
debug mechanisms, not a second native lifecycle interface.

## Uninstall

```bash
aidlc uninstall
aidlc uninstall --purge --yes
```

Uninstall removes the installer-owned command and all retained versions but
never changes project trees. Without `--purge`, it preserves machine config,
update cache, pin registrations, and the default harness. `--purge` removes
those machine records too.

Uninstall requires confirmation and refuses a root-owned, package-manager-owned,
or mixed-ownership command. On Windows it schedules verified cleanup after the
running command exits and resumes an interrupted continuation on the next
command.
