# SPDX-License-Identifier: MIT-0
# Copyright (c) 2025 AIDLC Deny Hook Contributors
"""CLI entry point for the AIDLC deny-dangerous hook."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Optional

from deny_hook import __version__
from deny_hook.checker import check_payload
from deny_hook.models import DenyResult, ToolPayload


def _parse_payload(data: dict) -> ToolPayload:
    """Parse various JSON payload formats into a ToolPayload.

    Supports:
    - {"tool_name": "bash", "command": "..."}
    - {"tool_name": "bash", "command": "...", "file_path": "..."}
    - {"toolName": "bash", "toolArgs": {"command": "..."}}
    - {"toolCall": {"name": "bash", "args": {"command": "..."}}}
    """
    # Format 1: flat with tool_name and command
    if "tool_name" in data and "command" in data:
        return ToolPayload(
            tool_name=data["tool_name"],
            command=data["command"],
            file_path=data.get("file_path"),
        )

    # Format 2: camelCase with toolArgs
    if "toolName" in data:
        args = data.get("toolArgs", {})
        command = args.get("command", "") if isinstance(args, dict) else ""
        file_path = args.get("file_path") or args.get("filePath") if isinstance(args, dict) else None
        return ToolPayload(
            tool_name=data["toolName"],
            command=command,
            file_path=file_path,
        )

    # Format 3: nested toolCall
    if "toolCall" in data:
        tool_call = data["toolCall"]
        name = tool_call.get("name", "")
        args = tool_call.get("args", {})
        command = args.get("command", "") if isinstance(args, dict) else ""
        file_path = args.get("file_path") or args.get("filePath") if isinstance(args, dict) else None
        return ToolPayload(
            tool_name=name,
            command=command,
            file_path=file_path,
        )

    # Fallback: try to extract what we can
    tool_name = data.get("name", data.get("tool", "unknown"))
    command = data.get("command", data.get("input", ""))
    file_path = data.get("file_path", data.get("path"))
    return ToolPayload(tool_name=tool_name, command=command, file_path=file_path)


def _run_check(command: str, tool_name: str = "bash") -> DenyResult:
    """Run a quick check on a raw command string."""
    payload = ToolPayload(tool_name=tool_name, command=command)
    return check_payload(payload)


def main(argv: Optional[list[str]] = None) -> None:
    """Main entry point for the deny hook CLI."""
    parser = argparse.ArgumentParser(
        prog="aidlc-deny-hook",
        description="Deny-dangerous hook for AI coding agents. "
        "Reads a JSON tool-call payload from stdin and returns allow/deny.",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}",
    )
    parser.add_argument(
        "--check",
        metavar="COMMAND",
        help="Quick-check a raw command string (uses 'bash' as tool name)",
    )
    parser.add_argument(
        "--tool",
        default="bash",
        help="Tool name to use with --check (default: bash)",
    )

    args = parser.parse_args(argv)

    if args.check:
        result = _run_check(args.check, tool_name=args.tool)
    else:
        # Read JSON from stdin
        try:
            raw = sys.stdin.read()
            if not raw.strip():
                print(json.dumps({"error": "No input provided on stdin"}), file=sys.stderr)
                sys.exit(2)
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"Invalid JSON: {e}"}), file=sys.stderr)
            sys.exit(2)

        try:
            payload = _parse_payload(data)
        except (KeyError, TypeError) as e:
            print(json.dumps({"error": f"Failed to parse payload: {e}"}), file=sys.stderr)
            sys.exit(2)

        result = check_payload(payload)

    # Output result
    print(json.dumps(result.to_dict()))

    # Exit code: 0 for allow, 1 for deny
    sys.exit(0 if result.allowed else 1)


if __name__ == "__main__":
    main()
