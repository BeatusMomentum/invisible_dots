"""Tests for ReadFileTool: read dedup, binary files, device blacklist, line endings."""

import os
import sys

import pytest
from fakes.local_computer import LocalComputer

from nanobot.agent.tools import file_state
from nanobot.agent.tools.filesystem import ReadFileTool, WriteFileTool

# ---------------------------------------------------------------------------
# Description fix
# ---------------------------------------------------------------------------

class TestReadDescriptionFix:

    def test_description_says_text_only(self, tmp_path):
        desc = ReadFileTool(computer=LocalComputer(tmp_path)).description.lower()
        assert "text" in desc
        for gone in ("image", "pdf", "docx", "xlsx", "pptx", "office"):
            assert gone not in desc


# ---------------------------------------------------------------------------
# Read deduplication
# ---------------------------------------------------------------------------

class TestReadDedup:
    """Only reads whose original result remains in context may return a stub."""

    @pytest.fixture()
    def tool(self, tmp_path):
        return ReadFileTool(computer=LocalComputer(tmp_path))

    @pytest.fixture()
    def write_tool(self, tmp_path):
        return WriteFileTool(computer=LocalComputer(tmp_path))

    @pytest.mark.asyncio
    async def test_second_read_returns_unchanged_stub(self, tool, tmp_path):
        f = tmp_path / "data.txt"
        f.write_text("\n".join(f"line {i}" for i in range(100)), encoding="utf-8")
        with file_state.file_read_context("read-1", lambda: {}):
            first = await tool.execute(path=str(f))
        assert "line 0" in first
        with file_state.file_read_context("read-2", lambda: {"read-1": first}):
            second = await tool.execute(path=str(f))
        assert "unchanged" in second.lower()
        # Stub should not contain file content
        assert "line 0" not in second

    @pytest.mark.asyncio
    async def test_read_after_external_modification_returns_full(self, tool, tmp_path):
        f = tmp_path / "data.txt"
        f.write_text("original", encoding="utf-8")
        with file_state.file_read_context("read-1", lambda: {}):
            first = await tool.execute(path=str(f))
        # Modify the file externally
        f.write_text("modified content", encoding="utf-8")
        with file_state.file_read_context("read-2", lambda: {"read-1": first}):
            second = await tool.execute(path=str(f))
        assert "modified content" in second

    @pytest.mark.asyncio
    async def test_different_offset_returns_full(self, tool, tmp_path):
        f = tmp_path / "data.txt"
        f.write_text("\n".join(f"line {i}" for i in range(1, 21)), encoding="utf-8")
        with file_state.file_read_context("read-1", lambda: {}):
            first = await tool.execute(path=str(f), offset=1, limit=5)
        with file_state.file_read_context("read-2", lambda: {"read-1": first}):
            second = await tool.execute(path=str(f), offset=6, limit=5)
        # Different offset → full read, not stub
        assert "line 6" in second

    @pytest.mark.asyncio
    async def test_first_read_after_write_returns_full_content(self, tool, write_tool, tmp_path):
        f = tmp_path / "fresh.txt"
        result = await write_tool.execute(path=str(f), content="hello")
        assert "Successfully" in result
        read_result = await tool.execute(path=str(f))
        assert "hello" in read_result
        assert "unchanged" not in read_result.lower()

    @pytest.mark.asyncio
    async def test_image_file_is_reported_as_binary(self, tool, tmp_path):
        f = tmp_path / "img.png"
        f.write_bytes(b"\x89PNG\r\n\x1a\nfake-png-data")

        result = await tool.execute(path=str(f))

        assert isinstance(result, str)
        assert "Cannot read binary file" in result

    @pytest.mark.asyncio
    async def test_known_text_extension_falls_back_to_latin1(self, tool, tmp_path):
        f = tmp_path / "legacy.csv"
        f.write_bytes("name\ncafé".encode("latin-1"))

        result = await tool.execute(path=str(f))

        assert "1| name" in result
        assert "2| café" in result

    @pytest.mark.parametrize("encoding", ["utf-8-sig", "utf-16", "utf-32"])
    @pytest.mark.asyncio
    async def test_bom_marked_unicode_text_uses_declared_encoding(
        self,
        tool,
        tmp_path,
        encoding,
    ):
        f = tmp_path / "unicode.txt"
        f.write_bytes("Hello 世界\nSecond line".encode(encoding))

        result = await tool.execute(path=str(f))

        assert "1| Hello 世界" in result
        assert "2| Second line" in result
        assert "\x00" not in result

    @pytest.mark.parametrize("encoding", ["utf-8-sig", "utf-16", "utf-32"])
    @pytest.mark.asyncio
    async def test_bom_only_unicode_text_is_empty_file(self, tool, tmp_path, encoding):
        f = tmp_path / "empty.txt"
        f.write_bytes("".encode(encoding))

        result = await tool.execute(path=str(f))

        assert result == f"(Empty file: {f})"


# ---------------------------------------------------------------------------
# Cross-session isolation (issue #3571)
# ---------------------------------------------------------------------------
# Each session must keep its own read cache. When session A reads a file,
# session B reading the same file must still receive the full content, not
# the "[File unchanged since last read]" dedup stub. Within each session,
# the original result must also remain in the current model context.

class TestReadDedupSessionIsolation:

    @pytest.mark.asyncio
    async def test_separate_sessions_do_not_share_dedup_state(self, tmp_path):
        f = tmp_path / "shared.txt"
        f.write_text("\n".join(f"line {i}" for i in range(10)), encoding="utf-8")

        session_a_tool = ReadFileTool(computer=LocalComputer(tmp_path))
        session_b_tool = ReadFileTool(computer=LocalComputer(tmp_path))

        first = await session_a_tool.execute(path=str(f))
        assert "line 0" in first

        # Session B has never read this file before - it must see the full
        # content, not the dedup stub from session A.
        second = await session_b_tool.execute(path=str(f))
        assert "unchanged" not in second.lower(), (
            "Session B should not inherit session A's read-dedup state. "
            f"Got: {second!r}"
        )
        assert "line 0" in second


# ---------------------------------------------------------------------------
# PDF support
# ---------------------------------------------------------------------------

class TestReadBinaryDocuments:
    """There is no document or image understanding: a binary file is reported as binary."""

    @pytest.fixture()
    def tool(self, tmp_path):
        return ReadFileTool(computer=LocalComputer(tmp_path))

    @pytest.mark.asyncio
    @pytest.mark.parametrize("name", ["report.pdf", "report.docx", "sheet.xlsx", "deck.pptx"])
    async def test_document_is_reported_as_binary(self, tool, tmp_path, name):
        f = tmp_path / name
        f.write_bytes(b"%PDF-1.4\n\x80\x81\x82binary")

        result = await tool.execute(path=str(f))

        assert "Error" in result
        assert "Cannot read binary file" in result

    @pytest.mark.asyncio
    async def test_file_not_found_error(self, tool, tmp_path):
        result = await tool.execute(path=str(tmp_path / "nope.pdf"))
        assert "Error" in result
        assert "not found" in result


# ---------------------------------------------------------------------------
# Device path blacklist
# ---------------------------------------------------------------------------

@pytest.mark.skipif(sys.platform == "win32", reason="/dev directory doesn't exist on Windows")
class TestReadDeviceBlacklist:

    @pytest.fixture()
    def tool(self, tmp_path):
        return ReadFileTool(computer=LocalComputer(tmp_path))

    @pytest.mark.asyncio
    async def test_dev_random_blocked(self, tool):
        result = await tool.execute(path="/dev/random")
        assert "Error" in result
        assert "blocked" in result.lower() or "device" in result.lower()

    @pytest.mark.asyncio
    async def test_dev_urandom_blocked(self, tool):
        result = await tool.execute(path="/dev/urandom")
        assert "Error" in result

    @pytest.mark.asyncio
    async def test_dev_zero_blocked(self, tool):
        result = await tool.execute(path="/dev/zero")
        assert "Error" in result

    @pytest.mark.asyncio
    async def test_proc_fd_blocked(self, tool):
        result = await tool.execute(path="/proc/self/fd/0")
        assert "Error" in result

    @pytest.mark.asyncio
    async def test_symlink_to_dev_zero_blocked(self, tmp_path):
        tool = ReadFileTool(computer=LocalComputer(tmp_path))
        link = tmp_path / "zero-link"
        link.symlink_to("/dev/zero")
        result = await tool.execute(path=str(link))
        assert "Error" in result
        assert "blocked" in result.lower() or "device" in result.lower()


# ---------------------------------------------------------------------------
# File changes with preserved mtime
# ---------------------------------------------------------------------------
# An editor can preserve mtime while replacing contents. Deduplication must
# compare the file snapshot even when the original result remains in context.

class TestFileStateHashFallback:

    async def test_read_returns_changed_content_when_mtime_same(self, tmp_path):
        f = tmp_path / "data.txt"
        f.write_text("original", encoding="utf-8")
        tool = ReadFileTool(computer=LocalComputer(tmp_path))
        with file_state.file_read_context("read-1", lambda: {}):
            first = await tool.execute(path=str(f))
        original_mtime = os.path.getmtime(f)

        f.write_text("modified", encoding="utf-8")
        os.utime(f, (original_mtime, original_mtime))
        assert os.path.getmtime(f) == original_mtime

        with file_state.file_read_context("read-2", lambda: {"read-1": first}):
            second = await tool.execute(path=str(f))
        assert "modified" in second
        assert "unchanged" not in second.lower()


# ---------------------------------------------------------------------------
# Line-ending normalization
# ---------------------------------------------------------------------------
# ReadFileTool normalizes CRLF -> LF before line-splitting. This primarily
# helps Windows users whose checkouts carry CRLF line endings and whose
# subsequent StrReplace edits would otherwise miss on `\r` boundaries. The
# normalization applies on all platforms; these tests lock that in so the
# behavior is intentional and discoverable, not accidental.

class TestReadFileLineEndingNormalization:

    @pytest.fixture()
    def tool(self, tmp_path):
        return ReadFileTool(computer=LocalComputer(tmp_path))

    @pytest.mark.asyncio
    async def test_crlf_is_normalized_to_lf(self, tool, tmp_path):
        f = tmp_path / "crlf.txt"
        f.write_bytes(b"alpha\r\nbeta\r\ngamma\r\n")
        result = await tool.execute(path=str(f))
        assert "\r" not in result
        assert "alpha" in result and "beta" in result and "gamma" in result

    @pytest.mark.asyncio
    async def test_lf_only_is_preserved(self, tool, tmp_path):
        f = tmp_path / "lf.txt"
        f.write_bytes(b"alpha\nbeta\ngamma\n")
        result = await tool.execute(path=str(f))
        assert "\r" not in result
        assert "alpha" in result and "beta" in result and "gamma" in result
