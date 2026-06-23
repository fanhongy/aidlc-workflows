# SPDX-License-Identifier: MIT-0
# Copyright (c) 2025 AIDLC Deny Hook Contributors
"""Tests for the CLI interface."""

from __future__ import annotations

import json
import subprocess
import sys
from unittest.mock import patch
from io import StringIO

import pytest

from deny_hook.cli import main


class TestCLICheck:
    """Tests for the --check flag."""

    def test_check_deny(self, capsys) -> None:
        with pytest.raises(SystemExit) as exc_info:
            main(["--check", "rm -rf /"])
        assert exc_info.value.code == 1
        output = json.loads(capsys.readouterr().out)
        assert output["allowed"] is False

    def test_check_allow(self, capsys) -> None:
        with pytest.raises(SystemExit) as exc_info:
            main(["--check", "ls -la"])
        assert exc_info.value.code == 0
        output = json.loads(capsys.readouterr().out)
        assert output["allowed"] is True

    def test_check_with_tool_flag(self, capsys) -> None:
        with pytest.raises(SystemExit) as exc_info:
            main(["--check", "cat .env", "--tool", "bash"])
        assert exc_info.value.code == 1
        output = json.loads(capsys.readouterr().out)
        assert output["allowed"] is False
        assert output["category"] == "secret_paths"

    def test_check_git_push(self, capsys) -> None:
        with pytest.raises(SystemExit) as exc_info:
            main(["--check", "git push origin main"])
        assert exc_info.value.code == 1
        output = json.loads(capsys.readouterr().out)
        assert output["allowed"] is False
        assert output["category"] == "repo_writes"


class TestCLIStdin:
    """Tests for stdin JSON parsing."""

    def test_stdin_flat_format_deny(self, capsys) -> None:
        payload = json.dumps({"tool_name": "bash", "command": "rm -rf /"})
        with patch("sys.stdin", StringIO(payload)):
            with pytest.raises(SystemExit) as exc_info:
                main([])
        assert exc_info.value.code == 1
        output = json.loads(capsys.readouterr().out)
        assert output["allowed"] is False

    def test_stdin_flat_format_allow(self, capsys) -> None:
        payload = json.dumps({"tool_name": "bash", "command": "ls -la"})
        with patch("sys.stdin", StringIO(payload)):
            with pytest.raises(SystemExit) as exc_info:
                main([])
        assert exc_info.value.code == 0
        output = json.loads(capsys.readouterr().out)
        assert output["allowed"] is True

    def test_stdin_camelcase_format(self, capsys) -> None:
        payload = json.dumps({"toolName": "bash", "toolArgs": {"command": "rm -rf /"}})
        with patch("sys.stdin", StringIO(payload)):
            with pytest.raises(SystemExit) as exc_info:
                main([])
        assert exc_info.value.code == 1
        output = json.loads(capsys.readouterr().out)
        assert output["allowed"] is False

    def test_stdin_nested_format(self, capsys) -> None:
        payload = json.dumps({"toolCall": {"name": "bash", "args": {"command": "git push"}}})
        with patch("sys.stdin", StringIO(payload)):
            with pytest.raises(SystemExit) as exc_info:
                main([])
        assert exc_info.value.code == 1
        output = json.loads(capsys.readouterr().out)
        assert output["allowed"] is False

    def test_stdin_empty_input(self, capsys) -> None:
        with patch("sys.stdin", StringIO("")):
            with pytest.raises(SystemExit) as exc_info:
                main([])
        assert exc_info.value.code == 2

    def test_stdin_invalid_json(self, capsys) -> None:
        with patch("sys.stdin", StringIO("not json")):
            with pytest.raises(SystemExit) as exc_info:
                main([])
        assert exc_info.value.code == 2


class TestCLIVersion:
    """Tests for the --version flag."""

    def test_version(self, capsys) -> None:
        with pytest.raises(SystemExit) as exc_info:
            main(["--version"])
        assert exc_info.value.code == 0
        output = capsys.readouterr().out
        assert "0.1.0" in output
