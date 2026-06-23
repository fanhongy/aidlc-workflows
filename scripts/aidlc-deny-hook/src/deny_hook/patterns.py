# SPDX-License-Identifier: MIT-0
# Copyright (c) 2025 AIDLC Deny Hook Contributors
"""Policy pattern checks adapted from goat-flow deny-dangerous hook.

Three categories:
1. Destructive shell commands
2. Secret file path access
3. Repository write operations
"""

from __future__ import annotations

import re
from typing import Optional

from deny_hook.models import DenyResult

# ---------------------------------------------------------------------------
# Category: Destructive Shell
# ---------------------------------------------------------------------------

# Safe targets that rm -rf is allowed to remove
_RM_SAFE_TARGETS = frozenset({
    "node_modules", "dist", "out", "build", "coverage",
    "__pycache__", ".cache", ".next", ".nuxt", ".turbo",
})


def _is_rm_rf_unsafe(command: str) -> Optional[str]:
    """Check if command contains rm -rf without safe scoping."""
    # Match rm with recursive flag
    rm_match = re.search(r"(^|[;\s&|])rm\s", command)
    if not rm_match:
        return None

    # Check for recursive flags
    has_recursive = bool(
        re.search(r"\s--recursive(\s|$)", command)
        or re.search(r"\s-[^-\s]*[rR]", command)
    )
    if not has_recursive:
        return None

    # Check for path traversal
    if ".." in command:
        return "rm -r with path traversal (..)"

    # Extract the part after rm and its flags
    rm_section = command[rm_match.start():].strip()
    # Get arguments (non-flag tokens after rm)
    tokens = rm_section.split()
    targets = [t for t in tokens[1:] if not t.startswith("-") and t != "--"]

    if not targets:
        return "rm -r without explicit target"

    for target in targets:
        target = target.strip("'\"")
        target = target.removeprefix("./").rstrip("/")
        if not target:
            return "rm -r targeting current directory"
        # Allow /tmp/build-* paths
        if re.match(r"^/tmp/build-[a-zA-Z0-9._-]", target):
            continue
        # Block absolute paths
        if target.startswith("/"):
            return f"rm -r with absolute path: {target}"
        if target.startswith("~"):
            return f"rm -r with home-relative path: {target}"
        # Windows drive paths
        if re.match(r"^[A-Za-z]:[/\\]", target):
            return f"rm -r with absolute path: {target}"
        # Safe well-known build artifact dirs
        if target in _RM_SAFE_TARGETS:
            continue
        # Paths with subdirectory components are considered scoped
        if "/" in target:
            continue
        return f"rm -r without safe scoping on target: {target}"

    return None


def _is_pipe_to_shell(command: str) -> bool:
    """Check for curl/wget piped to shell or interpreter."""
    return bool(re.search(
        r"(curl|wget|fetch|http)[^|]*\|\s*(ba)?sh",
        command,
    )) or bool(re.search(
        r"(curl|wget|fetch|http)[^|]*\|\s*(python|python3|node|perl|ruby)",
        command,
    ))


def _is_chmod_777(command: str) -> bool:
    """Check for chmod 777."""
    return bool(re.search(r"chmod\s+(\S+\s+)?0?777(\s|$)", command))


def _is_mkfs(command: str) -> bool:
    """Check for filesystem formatting commands."""
    return bool(re.search(r"(^|\s)mkfs(\.\S+)?\s", command))


def _is_dd_to_device(command: str) -> bool:
    """Check for dd writing to device paths."""
    if not re.search(r"(^|\s)dd\s", command):
        return False
    match = re.search(r"of=/dev/(\S+)", command)
    if not match:
        return False
    target = match.group(1)
    # Allow safe pseudo-devices
    if target in ("null", "stdout", "stderr") or target.startswith("fd/"):
        return False
    return True


def _is_eval(command: str) -> bool:
    """Check for eval usage."""
    return bool(re.search(r"(^|\s)eval\s", command))


def _is_lockfile_write(command: str) -> bool:
    """Check for direct lockfile modification."""
    lockfiles = r"(package-lock\.json|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|yarn\.lock)"
    # Direct redirect or tee to lockfile
    if re.search(rf"(>|>>|tee)\s+\S*{lockfiles}", command):
        return True
    # sed -i (in-place edit) touching a lockfile anywhere in the command
    if re.search(r"sed\s+-[a-zA-Z]*i", command) and re.search(lockfiles, command):
        return True
    return False


def _is_destructive_db(command: str) -> bool:
    """Check for destructive database commands via CLI."""
    cmd_lower = command.lower()
    has_db_cli = bool(re.search(r"(^|\s)(mysql|mariadb|psql|sqlite3|mongosh|cqlsh)(\s|$)", cmd_lower))
    if not has_db_cli:
        return False
    has_eval_flag = bool(re.search(r"(-e|-c|--command|--eval)", cmd_lower))
    if not has_eval_flag:
        return False
    has_destructive = bool(re.search(
        r"(drop\s+(database|table|schema|index|view)|truncate\s+table|delete\s+from)",
        cmd_lower,
    ))
    return has_destructive


def _is_sudo_package_mutation(command: str) -> bool:
    """Check for privileged package manager mutations."""
    return bool(re.search(
        r"(^|\s)sudo\s+(apt(-get)?|dnf|yum|pacman|brew)\s+(install|remove|upgrade|update)",
        command.lower(),
    ))


def _is_infra_destructive(command: str) -> bool:
    """Check for cloud/infrastructure destructive commands."""
    cmd_lower = command.lower()
    patterns = [
        r"(^|\s)terraform\s+destroy",
        r"(^|\s)terraform\s+apply\s+.*-auto-approve",
        r"(^|\s)aws\s+s3\s+rm",
        r"(^|\s)aws\s+ec2\s+terminate",
        r"(^|\s)docker\s+push",
    ]
    return any(re.search(p, cmd_lower) for p in patterns)


def check_destructive_shell(command: str) -> Optional[DenyResult]:
    """Check command against destructive shell patterns.

    Returns a DenyResult if denied, or None if allowed.
    """
    # rm -rf check
    rm_reason = _is_rm_rf_unsafe(command)
    if rm_reason:
        return DenyResult(allowed=False, reason=rm_reason, category="destructive_shell")

    if _is_pipe_to_shell(command):
        return DenyResult(
            allowed=False,
            reason="Pipe to shell/interpreter. Download first, inspect, then run.",
            category="destructive_shell",
        )

    if _is_chmod_777(command):
        return DenyResult(
            allowed=False,
            reason="chmod 777 sets world-writable permissions. Use a more restrictive mode.",
            category="destructive_shell",
        )

    if _is_mkfs(command):
        return DenyResult(
            allowed=False,
            reason="mkfs formats filesystems and can destroy data.",
            category="destructive_shell",
        )

    if _is_dd_to_device(command):
        return DenyResult(
            allowed=False,
            reason="dd writing to a device path can overwrite disks.",
            category="destructive_shell",
        )

    if _is_eval(command):
        return DenyResult(
            allowed=False,
            reason="eval hides commands from safety checks. Write the command directly.",
            category="destructive_shell",
        )

    if _is_lockfile_write(command):
        return DenyResult(
            allowed=False,
            reason="Direct lockfile modification. Use the package manager instead.",
            category="destructive_shell",
        )

    if _is_destructive_db(command):
        return DenyResult(
            allowed=False,
            reason="Destructive database command (DROP/TRUNCATE/DELETE). Run manually.",
            category="destructive_shell",
        )

    if _is_sudo_package_mutation(command):
        return DenyResult(
            allowed=False,
            reason="Privileged package-manager mutation. Run manually.",
            category="destructive_shell",
        )

    if _is_infra_destructive(command):
        return DenyResult(
            allowed=False,
            reason="Cloud/infrastructure destructive command. Run manually.",
            category="destructive_shell",
        )

    return None


# ---------------------------------------------------------------------------
# Category: Secret Paths
# ---------------------------------------------------------------------------

_SECRET_PATH_PATTERNS = [
    # Directories
    r"(^|\s|=|:|/|['\"])\.ssh/",
    r"(^|\s|=|:|/|['\"])\.aws/",
    r"(^|\s|=|:|/|['\"])\.config/gcloud/",
    r"(^|\s|=|:|/|['\"])\.gnupg/",
    r"(^|\s|=|:|/|['\"])\.docker/config\.json",
    r"(^|\s|=|:|/|['\"])\.kube/config",
    r"(^|\s|=|:|/|['\"])secrets/",
    # Credential files
    r"application_default_credentials\.json",
    r"(^|\s|=|:|/|['\"])(credentials|\.npmrc|\.pypirc)(\s|$|\.|['\"])",
]

_SECRET_PATH_COMPILED = [re.compile(p) for p in _SECRET_PATH_PATTERNS]

# Key material extensions
_KEY_MATERIAL_RE = re.compile(r"[^.\s][^\s]*\.(pem|key|pfx)(\s|$|['\"])", re.IGNORECASE)

# .env file pattern (but not .env.example)
_ENV_FILE_RE = re.compile(r"(^|\s|=|:|/|['\"])\.env[a-zA-Z0-9_.-]*(\s|$|['\"])")
_ENV_EXAMPLE_RE = re.compile(r"\.env\.example")


def check_secret_paths(command: str, file_path: Optional[str] = None) -> Optional[DenyResult]:
    """Check command/path against secret file path patterns.

    Returns a DenyResult if denied, or None if allowed.
    """
    # Check both the command and the file_path if provided
    texts_to_check = [command]
    if file_path:
        texts_to_check.append(file_path)

    for text in texts_to_check:
        # Check .env files (but allow .env.example for reads)
        if _ENV_FILE_RE.search(text):
            # If it only references .env.example, that is allowed for reads
            if _ENV_EXAMPLE_RE.search(text):
                # Only .env.example is referenced - check there is no other .env match
                masked = _ENV_EXAMPLE_RE.sub("__masked__", text)
                if not _ENV_FILE_RE.search(masked):
                    continue
            return DenyResult(
                allowed=False,
                reason="Access to .env file. Reading/editing environment files through the agent is a security risk.",
                category="secret_paths",
            )

        # Check known secret path patterns
        for pattern in _SECRET_PATH_COMPILED:
            if pattern.search(text):
                return DenyResult(
                    allowed=False,
                    reason="Access to secret/credential path. This is an exfiltration risk.",
                    category="secret_paths",
                )

        # Check key material files
        if _KEY_MATERIAL_RE.search(text):
            return DenyResult(
                allowed=False,
                reason="Access to key material file (.pem/.key/.pfx).",
                category="secret_paths",
            )

    return None


# ---------------------------------------------------------------------------
# Category: Repository Writes
# ---------------------------------------------------------------------------

# gh CLI write operations (topic:subcommand pairs that mutate state)
_GH_WRITE_OPS = frozenset({
    "issue:create", "issue:close", "issue:reopen", "issue:edit", "issue:delete",
    "issue:lock", "issue:unlock", "issue:pin", "issue:unpin", "issue:transfer",
    "pr:create", "pr:review", "pr:merge", "pr:close", "pr:reopen", "pr:edit",
    "pr:ready", "pr:update-branch",
    "release:create", "release:upload", "release:delete", "release:edit",
    "repo:create", "repo:delete", "repo:edit", "repo:fork", "repo:rename",
    "repo:archive", "repo:unarchive", "repo:sync",
    "label:create", "label:delete", "label:edit", "label:clone",
    "workflow:run", "workflow:disable", "workflow:enable",
    "run:rerun", "run:cancel", "run:delete",
    "gist:create", "gist:edit", "gist:delete",
    "secret:set", "secret:remove", "secret:delete",
    "variable:set", "variable:delete",
    "ssh-key:add", "ssh-key:delete", "gpg-key:add", "gpg-key:delete",
    "codespace:create", "codespace:delete", "codespace:edit",
    "project:create", "project:delete", "project:edit", "project:close",
    "cache:delete",
})


def _is_git_push(command: str) -> bool:
    """Check for git push or git send-pack."""
    return bool(re.search(r"(^|\s)git\s+(\S+\s+)*push(\s|$)", command)) or bool(
        re.search(r"(^|\s)git\s+(\S+\s+)*send-pack(\s|$)", command)
    )


def _is_git_commit(command: str) -> bool:
    """Check for git commit."""
    return bool(re.search(r"(^|\s)git\s+(\S+\s+)*commit(\s|$)", command))


def _is_git_destructive(command: str) -> bool:
    """Check for destructive git operations."""
    # --no-verify on any git command
    if re.search(r"(^|\s)git\s+.*--no-verify", command):
        return True
    # git reset --hard
    if re.search(r"(^|\s)git\s+(\S+\s+)*reset\s+.*--hard", command):
        return True
    # git clean -f / --force
    if re.search(r"(^|\s)git\s+(\S+\s+)*clean\s", command):
        if re.search(r"(--force|-[^-\s]*f)", command):
            return True
    return False


def _is_gh_write(command: str) -> bool:
    """Check for gh CLI write operations."""
    match = re.search(r"(^|\s|/)gh\s+", command)
    if not match:
        return False

    # Extract tokens after 'gh'
    rest = command[match.end():].strip()
    tokens = rest.split()
    if not tokens:
        return False

    # Skip global flags to find the topic
    topic_idx = 0
    while topic_idx < len(tokens) and tokens[topic_idx].startswith("-"):
        # Skip flag values
        if tokens[topic_idx] in ("--repo", "--hostname", "-R"):
            topic_idx += 2
        else:
            topic_idx += 1

    if topic_idx >= len(tokens):
        return False

    topic = tokens[topic_idx].lower()

    # gh api with write method
    if topic == "api":
        rest_after_api = " ".join(tokens[topic_idx + 1:]).lower()
        if re.search(r"-x\s+(post|put|patch|delete)", rest_after_api):
            return True
        if re.search(r"--method\s+(post|put|patch|delete)", rest_after_api):
            return True
        # Body fields imply POST
        if re.search(r"(-f|-F|--field|--raw-field)\s", rest_after_api):
            return True
        return False

    # Find subcommand
    sub_idx = topic_idx + 1
    while sub_idx < len(tokens) and tokens[sub_idx].startswith("-"):
        sub_idx += 1

    if sub_idx >= len(tokens):
        return False

    subcommand = tokens[sub_idx].lower()
    key = f"{topic}:{subcommand}"

    return key in _GH_WRITE_OPS


def check_repo_writes(command: str) -> Optional[DenyResult]:
    """Check command against repository write patterns.

    Returns a DenyResult if denied, or None if allowed.
    """
    if _is_git_push(command):
        return DenyResult(
            allowed=False,
            reason="git push is not allowed. Ask the user to push manually.",
            category="repo_writes",
        )

    if _is_git_commit(command):
        return DenyResult(
            allowed=False,
            reason="git commit is not allowed. Ask the user to commit manually.",
            category="repo_writes",
        )

    if _is_git_destructive(command):
        return DenyResult(
            allowed=False,
            reason="Destructive git operation (--no-verify / reset --hard / clean -f).",
            category="repo_writes",
        )

    if _is_gh_write(command):
        return DenyResult(
            allowed=False,
            reason="GitHub write via gh CLI is not allowed without explicit user approval.",
            category="repo_writes",
        )

    return None
