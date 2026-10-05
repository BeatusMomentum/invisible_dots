"""Line diffs behind the summaries of the file-editing tools."""

from __future__ import annotations

from dataclasses import dataclass

from rapidfuzz.distance import Indel


@dataclass(slots=True)
class FileDiff:
    """The lines added and deleted between two versions of a text."""

    added: int
    deleted: int

    @classmethod
    def from_text(cls, before: str, after: str) -> FileDiff:
        before_lines = before.replace("\r\n", "\n").splitlines()
        after_lines = after.replace("\r\n", "\n").splitlines()
        added = deleted = 0
        for code in Indel.opcodes(before_lines, after_lines):
            if code.tag in ("replace", "delete"):
                deleted += code.src_end - code.src_start
            if code.tag in ("replace", "insert"):
                added += code.dest_end - code.dest_start
        return cls(added, deleted)
