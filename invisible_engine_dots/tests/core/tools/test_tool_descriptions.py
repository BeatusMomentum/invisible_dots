from fakes.local_computer import LocalComputer

from nanobot.agent.tools.apply_patch import ApplyPatchTool
from nanobot.agent.tools.exec_session import (
    ExecSessionManager,
    ExecSessionTool,
    ListExecSessionsTool,
)
from nanobot.agent.tools.filesystem import EditFileTool, ReadFileTool, WriteFileTool
from nanobot.agent.tools.search import FindFilesTool, GrepTool
from nanobot.agent.tools.shell import ExecTool


def test_coding_tool_descriptions_steer_editing_priority(tmp_path) -> None:
    computer = LocalComputer(tmp_path)
    apply_patch = ApplyPatchTool(computer=computer).description.lower()
    edit_tool = EditFileTool(computer=computer)
    edit_file = edit_tool.description.lower()
    edit_parameters = edit_tool.parameters["properties"]
    write_file = WriteFileTool(computer=computer).description.lower()

    assert "default tool for code edits" in apply_patch
    assert "multi-file" in apply_patch
    assert "dry_run=true" in apply_patch
    assert "edit_file only for small exact replacements" in apply_patch

    assert "small, exact replacement" in edit_file
    assert "prefer apply_patch" in edit_file
    assert "occurrence, line_hint, and replace_all=true are mutually exclusive" in edit_file
    assert "copy it from read_file" in edit_parameters["old_text"]["description"].lower()
    assert "must differ from old_text" in edit_parameters["new_text"]["description"].lower()

    assert "replace an entire file" in write_file
    assert "prefer apply_patch" in write_file


def test_coding_tool_descriptions_steer_discovery(tmp_path) -> None:
    computer = LocalComputer(tmp_path)
    read_file = ReadFileTool(computer=computer).description.lower()
    find_files = FindFilesTool(computer=computer).description.lower()
    grep = GrepTool(computer=computer).description.lower()

    assert "text file" in read_file
    assert "line-numbered" in read_file
    assert "targeted ranges" in read_file
    assert len(read_file) < 160

    assert "workspace paths" in find_files
    assert "relative paths" in find_files
    assert len(find_files) < 140

    assert "text file content" in grep
    assert "five context lines" in grep
    assert len(grep) < 150

    assert "pages" not in ReadFileTool(computer=computer).parameters["properties"]
    assert "pages" not in GrepTool(computer=computer).parameters["properties"]


def test_exec_tool_descriptions_are_concise(tmp_path) -> None:
    manager = ExecSessionManager()
    exec_tool = ExecTool(LocalComputer(tmp_path))
    assert exec_tool.description == (
        "Run a shell command on the Dot's own Linux computer, as user dot, "
        "in /home/dot/workspace unless working_dir says otherwise."
    )
    assert ExecSessionTool(manager=manager).description == "Manage a session returned by exec."
    assert ListExecSessionsTool(manager=manager).description == "List active exec sessions."

    exec_parameters = exec_tool.parameters["properties"]
    assert "omit to wait for exit" in exec_parameters["yield_time_ms"]["description"]

    session_parameters = ExecSessionTool(manager=manager).parameters["properties"]
    assert set(session_parameters) == {
        "session_id",
        "input",
        "close_stdin",
        "terminate",
        "wait_for",
        "until_exit",
        "timeout_ms",
    }
    assert session_parameters["until_exit"]["description"] == "Wait for the process to exit."
    assert "wait_for" in session_parameters["timeout_ms"]["description"]
    assert "until_exit" in session_parameters["timeout_ms"]["description"]


def test_exec_offers_no_choice_of_local_shell(tmp_path) -> None:
    """The command always runs in the Dot's login shell, so no parameter picks one."""
    exec_parameters = ExecTool(LocalComputer(tmp_path)).parameters["properties"]

    assert "shell" not in exec_parameters
    assert "login" not in exec_parameters
