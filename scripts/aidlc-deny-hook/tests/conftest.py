# SPDX-License-Identifier: MIT-0
# Copyright (c) 2025 AIDLC Deny Hook Contributors
"""Shared fixtures for the deny hook test suite."""

from __future__ import annotations

import pytest

from deny_hook.models import ToolPayload


@pytest.fixture
def shell_payload():
    """Factory for creating shell tool payloads."""

    def _make(command: str, tool_name: str = "bash") -> ToolPayload:
        return ToolPayload(tool_name=tool_name, command=command)

    return _make


@pytest.fixture
def file_payload():
    """Factory for creating file tool payloads."""

    def _make(command: str = "", file_path: str = "", tool_name: str = "read_file") -> ToolPayload:
        return ToolPayload(tool_name=tool_name, command=command, file_path=file_path)

    return _make
