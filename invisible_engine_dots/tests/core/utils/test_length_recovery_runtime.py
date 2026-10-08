"""Tests for length-recovery prompt construction."""

from nanobot.utils.runtime import build_length_recovery_message


def test_length_recovery_message_anchors_the_existing_tail() -> None:
    omitted_prefix = "OMITTED_PREFIX"
    tail = "x" * 64

    message = build_length_recovery_message(omitted_prefix + tail)

    assert message["role"] == "user"
    assert omitted_prefix not in message["content"]
    assert f"<already_delivered_tail>\n{tail}\n</already_delivered_tail>" in message["content"]
    assert "Output only new continuation text" in message["content"]
    assert "Break remaining work into smaller steps" not in message["content"]


def test_a_response_cut_before_any_text_is_told_that_nothing_ran_and_to_work_in_smaller_steps() -> None:
    # The whole output budget went to a tool call that never finished (a large file written in one call):
    # there is no text to continue, and the call did not run.
    for blank in ("", "  \n"):
        message = build_length_recovery_message(blank)

        assert message["role"] == "user"
        assert "Continue the same response from its exact endpoint" not in message["content"]
        assert "no tool call in it ran" in message["content"]
        assert "smaller" in message["content"]
