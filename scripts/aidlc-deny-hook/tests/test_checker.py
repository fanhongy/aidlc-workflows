# SPDX-License-Identifier: MIT-0
# Copyright (c) 2025 AIDLC Deny Hook Contributors
"""Tests for the full check_payload flow."""

from __future__ import annotations

import pytest

from deny_hook.checker import check_payload
from deny_hook.models import ToolPayload


class TestCheckerFlow:
    """Tests for the checker orchestration logic."""

    def test_shell_tool_destructive_denied(self, shell_payload) -> None:
        result = check_payload(shell_payload("rm -rf /"))
        assert result.allowed is False
        assert result.category == "destructive_shell"

    def test_shell_tool_safe_command_allowed(self, shell_payload) -> None:
        result = check_payload(shell_payload("ls -la"))
        assert result.allowed is True

    def test_shell_tool_secret_path_denied(self, shell_payload) -> None:
        result = check_payload(shell_payload("cat .env"))
        assert result.allowed is False
        assert result.category == "secret_paths"

    def test_file_tool_secret_path_denied(self, file_payload) -> None:
        result = check_payload(file_payload(file_path="/home/user/.ssh/id_rsa"))
        assert result.allowed is False
        assert result.category == "secret_paths"

    def test_file_tool_normal_path_allowed(self, file_payload) -> None:
        result = check_payload(file_payload(file_path="src/main.py"))
        assert result.allowed is True

    def test_repo_write_denied_for_any_tool(self) -> None:
        payload = ToolPayload(tool_name="custom_tool", command="git push origin main")
        result = check_payload(payload)
        assert result.allowed is False
        assert result.category == "repo_writes"

    def test_unknown_tool_with_secret_file_path_denied(self) -> None:
        payload = ToolPayload(tool_name="some_custom_tool", command="read", file_path=".env.local")
        result = check_payload(payload)
        assert result.allowed is False
        assert result.category == "secret_paths"

    def test_unknown_tool_safe_command_allowed(self) -> None:
        payload = ToolPayload(tool_name="some_custom_tool", command="echo hello")
        result = check_payload(payload)
        assert result.allowed is True

    @pytest.mark.parametrize("tool_name", ["bash", "shell", "sh", "run_command", "execute_command"])
    def test_various_shell_tool_names(self, tool_name: str) -> None:
        payload = ToolPayload(tool_name=tool_name, command="rm -rf /")
        result = check_payload(payload)
        assert result.allowed is False

    @pytest.mark.parametrize("tool_name", ["read_file", "write_file", "edit_file", "read", "write", "edit"])
    def test_various_file_tool_names(self, tool_name: str) -> None:
        payload = ToolPayload(tool_name=tool_name, command="", file_path=".aws/credentials")
        result = check_payload(payload)
        assert result.allowed is False

    def test_first_deny_wins(self, shell_payload) -> None:
        # A command that triggers multiple categories - destructive wins since it checks first
        result = check_payload(shell_payload("rm -rf .env"))
        assert result.allowed is False
        assert result.category == "destructive_shell"
