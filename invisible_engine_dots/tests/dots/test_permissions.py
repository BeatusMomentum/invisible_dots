"""The one table of the Dot's tools and the permission each exercises."""

from __future__ import annotations

import pytest

from nanobot.dots.permissions import TOOL_PERMISSIONS, offered_tools, tool_permission


def test_every_tool_maps_to_the_permission_of_the_design() -> None:
    assert {name: entry.permission for name, entry in TOOL_PERMISSIONS.items()} == {
        "exec": "computer.exec",
        "exec_session": "computer.exec",
        "list_exec_sessions": "computer.exec",
        "read_file": "files.read",
        "list_dir": "files.read",
        "find_files": "files.read",
        "grep": "files.read",
        "write_file": "files.write",
        "edit_file": "files.write",
        "apply_patch": "files.write",
        "memory_search": "memory.read",
        "memory_get": "memory.read",
        "cron": "automations",
    }


def test_the_table_cannot_be_changed_by_a_caller() -> None:
    with pytest.raises(TypeError):
        TOOL_PERMISSIONS["web_search"] = TOOL_PERMISSIONS["exec"]  # type: ignore[index]


def test_a_tool_reports_its_permission_and_an_unknown_one_reports_none() -> None:
    assert tool_permission("apply_patch") == "files.write"
    assert tool_permission("memory_get") == "memory.read"
    for name in ("web_search", "web_fetch", "message", "spawn", "read", "process", ""):
        assert tool_permission(name) == ""


def test_the_model_is_offered_the_tools_whose_permission_is_allow_or_ask() -> None:
    assert offered_tools({"computer.exec": "ask", "files.read": "allow", "files.write": "deny", "automations": "ask"}) == [
        "cron",
        "exec",
        "exec_session",
        "find_files",
        "grep",
        "list_dir",
        "list_exec_sessions",
        "read_file",
    ]


def test_a_missing_permission_is_a_deny() -> None:
    assert offered_tools({}) == []
    assert offered_tools({"files.write": "deny"}) == []
    assert offered_tools({"files.write": "allow"}) == ["apply_patch", "edit_file", "write_file"]


def test_a_permission_the_table_does_not_know_offers_nothing() -> None:
    assert offered_tools({"web.fetch": "allow", "subagents": "allow", "message.send": "allow"}) == []


def test_the_memory_tools_follow_memory_enabled() -> None:
    permissions = {"memory.read": "allow", "files.read": "allow"}
    assert "memory_search" in offered_tools(permissions)
    assert "memory_get" in offered_tools(permissions, memory_enabled=True)
    without = offered_tools(permissions, memory_enabled=False)
    assert "memory_search" not in without and "memory_get" not in without
    assert "read_file" in without


def test_the_result_is_sorted() -> None:
    names = offered_tools({"computer.exec": "allow", "files.read": "allow", "files.write": "allow", "automations": "allow", "memory.read": "allow"})
    assert names == sorted(names)
    assert set(names) == set(TOOL_PERMISSIONS)


def _deps(tmp_path):
    from fakes.local_computer import LocalComputer

    from nanobot.agent.tools.exec_session import ExecSessionManager
    from nanobot.cron.service import CronService
    from nanobot.dots.permissions import ToolDeps

    return ToolDeps(
        computer=LocalComputer(tmp_path),
        exec_session_manager=ExecSessionManager(),
        cron_service=CronService(tmp_path / "cron" / "jobs.json"),
    )


def test_build_registry_registers_exactly_the_tools_of_the_table(tmp_path) -> None:
    from nanobot.dots.permissions import build_registry

    registry = build_registry(_deps(tmp_path))

    assert sorted(registry.tool_names) == sorted(TOOL_PERMISSIONS)


def test_every_registered_tool_is_named_as_the_table_names_it(tmp_path) -> None:
    from nanobot.dots.permissions import build_registry

    registry = build_registry(_deps(tmp_path))

    for name in TOOL_PERMISSIONS:
        tool = registry.get(name)
        assert tool is not None and tool.name == name


def test_the_tools_of_one_registry_share_the_computer_of_the_deps(tmp_path) -> None:
    from nanobot.dots.permissions import build_registry

    deps = _deps(tmp_path)
    registry = build_registry(deps)

    for name in ("exec", "read_file", "write_file", "find_files", "grep", "apply_patch", "memory_get"):
        assert registry.get(name).computer is deps.computer


# --- the arguments the gate compares -----------------------------------------------------------------
#
# The gate treats two calls as the same when their arguments, after the tool's own cast and validation,
# have the same canonical JSON (store.canonical_arguments). Python's json tells 1 from 1.0, so the one
# way this could split a repeated identical call in two is a number that reaches the gate once as an int
# and once as a float. These tests close that for every tool of the table.


def _schema_nodes(schema, path):
    """Every schema node of a tool's parameters, with the path that leads to it."""
    yield path, schema
    for key, child in (schema.get("properties") or {}).items():
        yield from _schema_nodes(child, (*path, key))
    if isinstance(schema.get("items"), dict):
        yield from _schema_nodes(schema["items"], (*path, "[]"))
    if isinstance(schema.get("additionalProperties"), dict):
        yield from _schema_nodes(schema["additionalProperties"], (*path, "{}"))
    for key in ("anyOf", "oneOf", "allOf"):
        for index, child in enumerate(schema.get(key) or []):
            yield from _schema_nodes(child, (*path, f"{key}[{index}]"))


def _types(node) -> set[str]:
    declared = node.get("type")
    return set(declared) if isinstance(declared, list) else {declared}


def test_no_argument_of_a_tool_in_the_table_is_a_float_or_has_no_type(tmp_path) -> None:
    from nanobot.dots.permissions import build_registry

    registry = build_registry(_deps(tmp_path))
    for name in TOOL_PERMISSIONS:
        for path, node in _schema_nodes(registry.get(name).parameters, (name,)):
            types = _types(node)
            where = ".".join(path)
            assert types <= {"string", "integer", "boolean", "array", "object", "null"}, (
                f"{where} is typed {types}: a float argument makes 1 and 1.0 two calls; "
                "normalize store.canonical_arguments before adding one"
            )
            assert node.get("type") is not None, f"{where} has no type, so nothing casts it"
            if "integer" in types:
                assert len(path) == 2, f"{where} is a nested integer: extend the next test to reach it"


# What a valid call needs besides the argument under test, where the required fields alone are not enough.
_EXTRA_ARGUMENTS = {"cron": {"action": "add", "message": "m"}}


def _sample(schema):
    declared = [t for t in _types(schema) if t != "null"][0]
    if "enum" in schema:
        return schema["enum"][0]
    if declared == "string":
        return "x"
    if declared == "integer":
        return max(schema.get("minimum", 1), 1)
    if declared == "boolean":
        return True
    if declared == "array":
        return [_sample(schema["items"])]
    return {key: _sample(child) for key, child in schema.get("properties", {}).items() if key in schema.get("required", [])}


def test_an_integer_argument_reaches_the_gate_as_the_same_int_however_the_model_writes_it(tmp_path) -> None:
    from nanobot.dots.permissions import build_registry
    from nanobot.dots.store import canonical_arguments

    registry = build_registry(_deps(tmp_path))
    checked = []
    for name in TOOL_PERMISSIONS:
        schema = registry.get(name).parameters
        required = {key: _sample(schema["properties"][key]) for key in schema.get("required", [])}
        base = {**required, **_EXTRA_ARGUMENTS.get(name, {})}
        assert registry.prepare_call(name, dict(base))[2] is None, f"{name}: the base call of this test is not valid"
        for key, node in schema["properties"].items():
            if "integer" not in _types(node):
                continue
            value = _sample(node)

            def prepared(argument):
                _tool, params, error = registry.prepare_call(name, {**base, key: argument})
                return params, error

            as_int, error = prepared(value)
            assert error is None, f"{name}.{key}={value!r}: {error}"
            as_text, error = prepared(str(value))
            assert error is None, f"{name}.{key}={value!r} as text: {error}"
            # The two accepted spellings are one call.
            assert canonical_arguments(as_int) == canonical_arguments(as_text)
            assert as_int[key] == value and type(as_int[key]) is int
            # A float never gets through to the gate, however it is written.
            for spelling in (float(value), f"{value}.0", f"{value}e0"):
                _params, error = prepared(spelling)
                assert error is not None, f"{name}.{key}={spelling!r} was accepted"
            if value == 1:
                assert prepared(True)[1] is not None, f"{name}.{key}=True was accepted"
            checked.append(f"{name}.{key}")
    # The walk reached the integer arguments of the table, not none of them.
    assert {"exec.timeout", "read_file.limit", "grep.head_limit", "edit_file.occurrence", "cron.every_seconds"} <= set(checked)
