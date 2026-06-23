# SPDX-License-Identifier: MIT-0
# Copyright (c) 2025 AIDLC Deny Hook Contributors
"""Main checker that orchestrates all policy category checks."""

from __future__ import annotations

from deny_hook.models import DenyResult, ToolPayload
from deny_hook.patterns import check_destructive_shell, check_repo_writes, check_secret_paths

# Tool names that indicate shell/command execution
_SHELL_TOOLS = frozenset({
    "bash", "shell", "sh", "run_command", "execute_command",
    "terminal", "cmd", "command", "run", "exec",
})

# Tool names that indicate file operations
_FILE_TOOLS = frozenset({
    "read", "write", "edit", "read_file", "write_file", "edit_file",
    "create_file", "open", "save", "str_replace_editor",
})


def check_payload(payload: ToolPayload) -> DenyResult:
    """Check a tool call payload against all policy categories.

    Applies:
    - Destructive shell checks for shell-type tools
    - Secret path checks for both shell and file tools
    - Repository write checks for all tools

    Returns the first deny match, or an allow result.
    """
    tool_lower = payload.tool_name.lower()
    command = payload.command

    is_shell_tool = tool_lower in _SHELL_TOOLS
    is_file_tool = tool_lower in _FILE_TOOLS

    # For shell tools, run destructive shell checks
    if is_shell_tool:
        result = check_destructive_shell(command)
        if result:
            return result

    # Secret path checks apply to both shell and file tools
    if is_shell_tool or is_file_tool:
        result = check_secret_paths(command, payload.file_path)
        if result:
            return result

    # Repository write checks apply to all tool types
    result = check_repo_writes(command)
    if result:
        return result

    # If we have a file_path, also check it for secrets even for unknown tools
    if payload.file_path and not is_shell_tool and not is_file_tool:
        result = check_secret_paths("", payload.file_path)
        if result:
            return result

    return DenyResult(allowed=True)
