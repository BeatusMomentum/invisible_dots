"""A task's environment/Dockerfile, replayed in a Dot's computer as its user dot.

The Dot's computer is Ubuntu 24.04 with no root for dot but one: `sudo dot-install <package>...`, which
installs Ubuntu packages and takes nothing else (guest/image-builder/runtime/dot-install.sh). So:
- FROM is not pulled: a Python base adds python3, pip and venv once;
- apt-get install becomes dot-install of the same packages (versions pinned with `=` are dropped);
  apt-get update and clean, and removing apt's lists, are dropped (dot-install updates);
- pip installs go to dot's user site (`--user --break-system-packages`, Ubuntu's Python being "externally
  managed");
- WORKDIR, ENV, ARG are followed, COPY and ADD upload from the task's environment directory;
- every path under the roots of paths.py is moved under /home/dot/bench.
A step that still needs root fails, and so does the task's oracle: that task is not one a Dot can run.
"""

from __future__ import annotations

import re
import shlex
from dataclasses import dataclass, field

from .paths import map_paths

PYTHON_PACKAGES = ("python3", "python3-pip", "python3-venv", "python-is-python3")


@dataclass
class Step:
    kind: str  # "run", "copy", "workdir", "env"
    value: str = ""
    sources: list[str] = field(default_factory=list)
    target: str = ""


def _logical_lines(text: str) -> list[str]:
    lines: list[str] = []
    current = ""
    for raw in text.splitlines():
        stripped = raw.strip()
        if not current and (not stripped or stripped.startswith("#")):
            continue
        if stripped.startswith("#"):
            continue
        if raw.rstrip().endswith("\\"):
            current += raw.rstrip()[:-1] + " "
            continue
        current += raw
        lines.append(current.strip())
        current = ""
    if current.strip():
        lines.append(current.strip())
    return lines


def _apt_install(segment: str) -> str | None:
    """`apt-get install ... pkgs` as dot-install, or None when the segment is not an install."""
    words = shlex.split(segment)
    if len(words) < 2 or words[0] not in ("apt-get", "apt") or "install" not in words:
        return None
    packages = [w.split("=")[0] for w in words[words.index("install") + 1 :] if not w.startswith("-")]
    return f"sudo dot-install {' '.join(packages)}" if packages else "true"


_DROPPED = (
    re.compile(r"^(apt-get|apt)\s+(-\S+\s+)*(update|clean|autoremove|autoclean)\b"),
    re.compile(r"^rm\s+-rf?\s+/var/lib/apt/lists"),
)
_PIP = re.compile(r"^(python3?\s+-m\s+pip|pip3?)\s+install\b")


def rewrite_run(command: str, args: dict[str, str]) -> str:
    """A RUN command as dot can run it."""
    for name, value in args.items():
        command = command.replace(f"${{{name}}}", value).replace(f"${name}", value)
    segments = [part.strip() for part in re.split(r"\s*&&\s*", command)]
    out: list[str] = []
    for segment in segments:
        segment = re.sub(r"^DEBIAN_FRONTEND=\S+\s+", "", segment)
        if any(pattern.search(segment) for pattern in _DROPPED):
            continue
        installed = _apt_install(segment)
        if installed is not None:
            out.append(installed)
            continue
        if _PIP.search(segment) and "--user" not in segment:
            segment = _PIP.sub(lambda m: f"{m.group(0)} --user --break-system-packages", segment, count=1)
        out.append(segment)
    return map_paths(" && ".join(out) if out else "true")


def parse(text: str) -> tuple[list[Step], bool]:
    """The steps of a Dockerfile's last stage, and whether its base is a Python image."""
    steps: list[Step] = []
    args: dict[str, str] = {}
    python_base = False
    for line in _logical_lines(text):
        instruction, _, rest = line.partition(" ")
        instruction = instruction.upper()
        rest = rest.strip()
        if instruction == "FROM":
            # A later stage starts again; only the last one is the task's.
            steps = []
            python_base = rest.split()[0].startswith("python:")
        elif instruction == "ARG":
            name, _, default = rest.partition("=")
            args[name.strip()] = default.strip().strip('"')
        elif instruction == "RUN":
            steps.append(Step("run", rewrite_run(rest, args)))
        elif instruction == "WORKDIR":
            steps.append(Step("workdir", map_paths(rest.strip('"'))))
        elif instruction == "ENV":
            pairs = re.findall(r'(\w+)=("[^"]*"|\S+)', rest) or [tuple(rest.split(None, 1))]
            for name, value in pairs:
                steps.append(Step("env", map_paths(value.strip('"')), target=name))
        elif instruction in ("COPY", "ADD"):
            words = [w for w in shlex.split(rest) if not w.startswith("--chown") and not w.startswith("--chmod")]
            if any(w.startswith("--from") for w in words):
                steps.append(Step("run", "echo 'COPY --from is not replayed' >&2 && false"))
                continue
            steps.append(Step("copy", sources=words[:-1], target=map_paths(words[-1])))
    return steps, python_base
