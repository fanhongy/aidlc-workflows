# aidlc-deny-hook

A deny-dangerous hook for AI coding agents. Checks tool-call payloads against
three policy categories and blocks dangerous operations before they execute.

## Policy Categories

1. **Destructive Shell** - Blocks commands that can cause irreversible damage:
   - `rm -rf` without safe scoping
   - `curl | bash` pipe-to-shell patterns
   - `chmod 777` world-writable permissions
   - `mkfs`, `dd` to devices
   - `eval` (hides commands from inspection)
   - Direct lockfile writes
   - Destructive database commands (DROP TABLE, TRUNCATE)
   - Privileged package manager mutations (`sudo apt install`)
   - Cloud infrastructure destructive commands (terraform destroy, aws s3 rm)

2. **Secret Paths** - Blocks access to credential files:
   - `.env` files (allows `.env.example` reads)
   - `.ssh/`, `.aws/`, `.gnupg/`, `.docker/config.json`, `.kube/config`
   - `secrets/` directories
   - Key material (`.pem`, `.key`, `.pfx`)
   - `.npmrc`, `.pypirc`, `credentials`

3. **Repository Writes** - Blocks mutations to the repository:
   - `git push`, `git commit`
   - `git reset --hard`, `git clean -f`
   - `--no-verify` flag on any git command
   - `gh` CLI write operations (issue create, pr create, release create, etc.)

## Installation

```bash
cd scripts/aidlc-deny-hook
uv sync
```

## Usage

### Via stdin (primary mode)

Feed a JSON tool-call payload on stdin:

```bash
echo '{"tool_name": "bash", "command": "rm -rf /"}' | aidlc-deny-hook
# Output: {"allowed": false, "reason": "rm -r with absolute path: /", "category": "destructive_shell"}
# Exit code: 1

echo '{"tool_name": "bash", "command": "ls -la"}' | aidlc-deny-hook
# Output: {"allowed": true}
# Exit code: 0
```

### Via --check flag (quick testing)

```bash
aidlc-deny-hook --check "git push origin main"
# Output: {"allowed": false, "reason": "git push is not allowed...", "category": "repo_writes"}
# Exit code: 1
```

### Supported input formats

```json
{"tool_name": "bash", "command": "...", "file_path": "..."}
{"toolName": "bash", "toolArgs": {"command": "..."}}
{"toolCall": {"name": "bash", "args": {"command": "..."}}}
```

### Exit codes

- `0` - Command is allowed
- `1` - Command is denied
- `2` - Input error (invalid JSON, empty stdin)

## Integration

### Claude Code hooks.json

```json
{
  "hooks": {
    "pre_tool_call": [
      {
        "command": "aidlc-deny-hook"
      }
    ]
  }
}
```

### As a library

```python
from deny_hook.checker import check_payload
from deny_hook.models import ToolPayload

payload = ToolPayload(tool_name="bash", command="rm -rf /")
result = check_payload(payload)
if not result.allowed:
    print(f"Denied: {result.reason} ({result.category})")
```

## Known Limitations

This hook is a **defense-in-depth measure**, not a security boundary. It provides
an additional safety layer but cannot guarantee complete prevention of dangerous
operations. Known gaps include:

- **Regex evasion**: Shell quoting (e.g., `r"m" -rf /`), variable expansion
  (e.g., `$CMD`), subshell invocation (e.g., `bash -c "rm -rf /"`), and
  multi-line here-docs can all bypass string-match patterns. The hook inspects
  the literal command text and cannot evaluate shell semantics.

- **Tool-name allowlist boundary**: Destructive-shell patterns only fire for
  recognized shell tool names (bash, sh, run_command, etc.). An agent tool with
  an unrecognized name that executes shell commands will only be checked against
  the repo-writes policy, not destructive-shell patterns.

- **Not a sandbox replacement**: This hook complements (but does not replace)
  proper sandboxing, filesystem permissions, and network isolation. Treat it as
  one layer in a defense-in-depth strategy.

## Development

```bash
# Install dev dependencies
uv sync --extra dev

# Run tests
uv run pytest tests/ -v

# Run a specific test
uv run pytest tests/test_patterns.py -v
```
