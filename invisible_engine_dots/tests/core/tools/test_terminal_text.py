"""What the model reads of a terminal session: the screen's text, not the byte stream."""

from __future__ import annotations

import pytest

from nanobot.agent.tools.exec_session import terminal_text


def _text(raw: str) -> str:
    text, pending = terminal_text(raw)
    assert pending == ""
    return text


def test_plain_text_is_unchanged() -> None:
    assert _text("name? ") == "name? "
    assert _text("a\tb\nc\n") == "a\tb\nc\n"
    assert _text("") == ""


def test_a_terminal_line_ending_is_a_newline() -> None:
    assert _text("one\r\ntwo\r\n") == "one\ntwo\n"


def test_colors_and_cursor_moves_are_dropped() -> None:
    assert _text("\x1b[1;31mred\x1b[0m and \x1b[38;5;208morange\x1b[m\n") == "red and orange\n"
    assert _text("a\x1b[2Ab\x1b[3Dc\x1b[10;20Hd\x1b[?25l\x1b[?2004h") == "abcd"


def test_operating_system_commands_are_dropped_with_either_terminator() -> None:
    assert _text("\x1b]0;user@host: ~\x07$ ") == "$ "
    assert _text("\x1b]8;;https://example.org\x1b\\link\x1b]8;;\x1b\\") == "link"


def test_charset_and_keypad_escapes_are_dropped() -> None:
    assert _text("\x1b(Bplain\x1b=\x1b>") == "plain"


def test_a_progress_bar_is_its_last_state() -> None:
    assert _text("10%\r50%\r100%\n") == "100%\n"
    assert _text("downloading  1%\rdownloading 99%\n") == "downloading 99%\n"


def test_a_carriage_return_overwrites_only_what_it_covers() -> None:
    assert _text("abcdef\rXY") == "XYcdef"


def test_erase_line_after_a_carriage_return_leaves_the_new_text_alone() -> None:
    assert _text("a long first line\r\x1b[Kshort\n") == "short\n"
    assert _text("abcdef\x1b[2Kxy") == "      xy"
    assert _text("keep\x1b[2K\rnew\n") == "new\n"
    assert _text("abcdef\x1b[1Kxy") == "      xy"  # from the start of the line to the cursor
    assert _text("abcdef\rXY\x1b[Kz") == "XYz"  # from the cursor to the end of the line


def test_a_backspace_steps_back_one_column() -> None:
    assert _text("ab\bc") == "ac"
    assert _text("N\bNA\bAM\bME\bE") == "NAME"


def test_other_control_characters_are_dropped() -> None:
    assert _text("a\x07b\x00c\x7fd") == "abcd"


def test_an_escape_sequence_cut_by_the_end_of_the_chunk_waits_for_its_rest() -> None:
    for head, tail in (
        ("red \x1b", "[31mtext"),
        ("red \x1b[", "31mtext"),
        ("red \x1b[3", "1mtext"),
        ("red \x1b[31", "mtext"),
    ):
        first, pending = terminal_text(head)
        assert first == "red "
        assert pending == head[len("red "):]
        second, pending = terminal_text(pending + tail)
        assert (first + second, pending) == ("red text", "")


def test_an_operating_system_command_cut_by_the_end_of_the_chunk_waits_for_its_end() -> None:
    first, pending = terminal_text("$ \x1b]0;a title")
    assert (first, pending) == ("$ ", "\x1b]0;a title")
    second, pending = terminal_text(pending + "\x07ls\n")
    assert (second, pending) == ("ls\n", "")

    first, pending = terminal_text("\x1b]0;a title\x1b")
    assert (first, pending) == ("", "\x1b]0;a title\x1b")
    second, pending = terminal_text(pending + "\\done")
    assert (second, pending) == ("done", "")


def test_the_end_of_the_stream_flushes_what_was_waiting() -> None:
    text, pending = terminal_text("tail \x1b[3", final=True)
    assert (text, pending) == ("tail ", "")


def test_an_unfinished_string_does_not_swallow_the_session() -> None:
    raw = "\x1b]0;" + "x" * 10_000
    text, pending = terminal_text(raw)
    assert text == ""
    assert pending == ""
    assert _text("after") == "after"


def test_a_broken_sequence_loses_only_itself() -> None:
    # ESC [ followed by a control character is not a CSI sequence; the text after it is kept.
    assert _text("a\x1b[\nb") == "a\nb"
    # An escape that starts a new escape.
    assert _text("a\x1b\x1b[31mb") == "ab"


@pytest.mark.parametrize(
    "raw", ["", "plain", "a\nb\r\nc\r\n", "x\x1b[0my", "\x1b[1;31mred\x1b[0m\r\n\x1b]0;t\x07$ ", "café\x1b(B\n"]
)
def test_the_text_is_the_same_whole_or_cut_anywhere(raw: str) -> None:
    whole = terminal_text(raw, final=True)[0]
    for cut in range(len(raw) + 1):
        first, pending = terminal_text(raw[:cut])
        second, pending = terminal_text(pending + raw[cut:], final=True)
        assert pending == ""
        assert first + second == whole


def test_a_line_overwritten_across_two_chunks_is_two_outputs() -> None:
    # The screen of a terminal is not kept between polls: the model reads what changed since the last one.
    first, pending = terminal_text("abc\r")
    second, pending = terminal_text(pending + "de", final=True)
    assert (first, second) == ("abc", "de")
