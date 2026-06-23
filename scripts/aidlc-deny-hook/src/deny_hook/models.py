# SPDX-License-Identifier: MIT-0
# Copyright (c) 2025 AIDLC Deny Hook Contributors
"""Data models for the deny hook."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class ToolPayload:
    """Represents a tool call to be checked."""

    tool_name: str
    command: str
    file_path: Optional[str] = None


@dataclass
class DenyResult:
    """Result of a policy check."""

    allowed: bool
    reason: Optional[str] = None
    category: Optional[str] = None

    def to_dict(self) -> dict:
        """Convert to JSON-serializable dictionary."""
        result: dict = {"allowed": self.allowed}
        if self.reason is not None:
            result["reason"] = self.reason
        if self.category is not None:
            result["category"] = self.category
        return result
