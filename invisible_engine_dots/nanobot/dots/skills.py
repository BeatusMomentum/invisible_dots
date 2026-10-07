"""The Dot's skills: how it does a kind of task, one folder each holding a SKILL.md.

The layout is the Agent Skills one Claude Code and upstream nanobot read: a folder named for the skill, and in it
SKILL.md, which opens with a frontmatter giving its `name` (the folder's name) and a one-line `description` of when
it applies, then says how. Built-in skills ship with the engine (`skills/<name>/SKILL.md`, beside `nanobot/`); the Dot's own are
under /home/dot/skills/<name>/SKILL.md, written by the Dot with its file tools, and one of its own replaces a built-in
one of the same name. The prompt names each skill with its description and the path of its file, and the Dot reads
that file when a task is one the skill covers: only the names and descriptions are in every request.
"""

from __future__ import annotations

import posixpath
import re
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Literal

from loguru import logger

from nanobot.dots.computer import Computer, ComputerError, FileTooLargeError

# Where the built-in skills are: beside the engine's package (no upstream name in a path the model reads), the same
# path for the engine and for the Dot's file tools.
BUILTIN_SKILLS_DIR = Path(__file__).resolve().parents[2] / "skills"
# Where the Dot keeps its own.
DOT_SKILLS_DIR = "/home/dot/skills"
# A skill's file is read whole for the person's view; a longer one is not a skill.
MAX_SKILL_BYTES = 256 * 1024

_FRONTMATTER = re.compile(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.DOTALL)
_FIELD = re.compile(r"^([a-z]+):[ \t]*(.*?)[ \t]*$")
# The Agent Skills rule for a name: lowercase letters, digits and single hyphens, at most 64.
_NAME = re.compile(r"^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")


@dataclass(frozen=True)
class Skill:
    name: str
    description: str
    # The SKILL.md as the Dot's file tools reach it.
    path: str
    source: Literal["builtin", "dot"]
    content: str


def parse_skill(text: str, folder: str) -> tuple[str, str] | None:
    """The name and description a SKILL.md declares, or None when it is no skill of the folder it is in.

    The frontmatter's fields are single lines (`name: x`, `description: y`); the name must be the folder's.
    """
    match = _FRONTMATTER.match(text)
    if match is None:
        return None
    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        field = _FIELD.match(line)
        if field:
            fields[field.group(1)] = field.group(2).strip("\"'")
    name, description = fields.get("name", ""), fields.get("description", "")
    if name != folder or _NAME.match(name) is None or not 1 <= len(description) <= 1024:
        return None
    return name, description


@cache
def builtin_skills() -> tuple[Skill, ...]:
    """The skills that ship with the engine, read once."""
    skills: list[Skill] = []
    for file in sorted(BUILTIN_SKILLS_DIR.glob("*/SKILL.md")):
        content = file.read_text(encoding="utf-8")
        parsed = parse_skill(content, file.parent.name)
        if parsed is None:
            raise ValueError(f"{file} is not a valid skill: its frontmatter must name its folder and describe it")
        skills.append(Skill(parsed[0], parsed[1], file.as_posix(), "builtin", content))
    return tuple(skills)


async def dot_skills(computer: Computer) -> list[Skill]:
    """The skills the Dot wrote, read from its computer; one that does not read or parse is left out and logged."""
    try:
        entries = await computer.list_dir(DOT_SKILLS_DIR)
    except ComputerError:
        logger.warning("could not list {}", DOT_SKILLS_DIR)
        return []
    skills: list[Skill] = []
    for entry in sorted(entries or [], key=lambda e: e.name):
        if entry.type != "dir":
            continue
        path = posixpath.join(DOT_SKILLS_DIR, entry.name, "SKILL.md")
        try:
            raw = await computer.read_bytes(path, max_bytes=MAX_SKILL_BYTES)
        except (ComputerError, FileTooLargeError) as error:
            logger.warning("could not read the skill {}: {}", path, error)
            continue
        if raw is None:
            continue
        content = raw.decode("utf-8", errors="replace")
        parsed = parse_skill(content, entry.name)
        if parsed is None:
            logger.warning("{} is not a valid skill: its frontmatter must name its folder and describe it", path)
            continue
        skills.append(Skill(parsed[0], parsed[1], path, "dot", content))
    return skills


async def all_skills(computer: Computer) -> list[Skill]:
    """Every skill the Dot has, by name: its own, and the built-in ones it has not replaced."""
    own = await dot_skills(computer)
    names = {skill.name for skill in own}
    return sorted([*own, *(skill for skill in builtin_skills() if skill.name not in names)], key=lambda s: s.name)
