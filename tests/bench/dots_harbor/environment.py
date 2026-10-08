"""A Harbor environment that is a Dot: a new one for each trial, deleted after it.

    harbor run -e dots_harbor.environment:DotEnvironment -a <agent> ...   (tests/bench/README.md)

The Dot is created through the product's API with a computer the size the task asks for, the task's
Dockerfile is replayed in it as dot (dockerfile.py), and every command, upload and download goes through
dot-agentd as dot, with the task's root paths moved under /home/dot/bench (paths.py). Nothing here has
root in the Dot: what a task needs root for fails, and its oracle with it.
"""

from __future__ import annotations

import hashlib
import io
import os
import posixpath
import shlex
import tarfile
from pathlib import Path, PurePosixPath

from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.environments.capabilities import EnvironmentCapabilities

from . import bridge
from .dockerfile import PYTHON_PACKAGES, parse
from .paths import BENCH_HOME, ROOTS, map_file, map_path, map_paths

ENV_FILE = f"{BENCH_HOME}/.env"
PERMISSIONS = (
    "computer.exec",
    "computer.screenshot",
    "files.read",
    "files.write",
    "browser.identity.list",
    "browser.identity.create",
    "browser.identity.delete",
    "browser.identity.launch",
    "browser.identity.close",
    "browser.navigate",
    "browser.read",
    "browser.act",
    "automations",
)


def dot_yaml(name: str, *, cpus: int, memory_gb: int) -> str:
    """The benchmark Dot's config: the model and limits the run names, every permission allowed (nobody is
    there to answer an approval)."""
    model = os.environ.get("BENCH_MODEL", "z-ai/glm-5.3-flash")
    lines = [
        f"name: {name}",
        "model:",
        "  provider: openrouter",
        f"  id: {model}",
        "computer:",
        f"  cpu: {cpus}",
        f"  memory: {memory_gb}gb",
        "  idle_timeout: 0",
        "limits:",
        f"  max_steps_per_task: {int(os.environ.get('BENCH_MAX_STEPS', '150'))}",
        f"  max_cost_per_task_usd: {float(os.environ.get('BENCH_MAX_COST_USD', '3'))}",
        "permissions:",
        *(f"  {permission}: allow" for permission in PERMISSIONS),
    ]
    return "\n".join(lines) + "\n"


class DotEnvironment(BaseEnvironment):
    def __init__(self, *args, **kwargs):
        self.dot_id: str | None = None
        self._workdir = f"{BENCH_HOME}/app"
        super().__init__(*args, **kwargs)

    @staticmethod
    def type() -> str:
        return "invisible-dots"

    @property
    def capabilities(self) -> EnvironmentCapabilities:
        return EnvironmentCapabilities()

    def _validate_definition(self):
        # A task with no Dockerfile runs on the Dot's computer as it is.
        return None

    # --- life ---------------------------------------------------------------

    async def start(self, force_build: bool) -> None:
        digest = hashlib.sha256(self.session_id.encode()).hexdigest()[:10]
        name = f"bench-{digest}"
        cpus = max(1, min(16, self._effective_cpus or 2))
        memory_gb = max(2, min(64, -(-(self._effective_memory_mb or 4096) // 1024)))
        created = await bridge.call("create", name, stdin=dot_yaml(name, cpus=cpus, memory_gb=memory_gb).encode())
        self.dot_id = created["id"]
        self.logger.info(f"Dot {name} ({self.dot_id}) is READY")
        await self._run_checked(
            "mkdir -p " + " ".join(shlex.quote(f"{BENCH_HOME}/{root}") for root in ROOTS) + f" && touch {ENV_FILE}",
            "make the task's roots",
        )
        # Harbor's log directories, which a mounted environment would bind from the host.
        await self.ensure_dirs([*self._mount_targets(writable_only=True), "/logs/agent", "/logs/verifier", "/logs/artifacts"])
        if self.task_env_config.workdir:
            self._workdir = map_path(self.task_env_config.workdir)
        dockerfile = self.environment_dir / "Dockerfile"
        if dockerfile.exists():
            await self._replay(dockerfile.read_text(encoding="utf-8"))
        await self._upload_environment_dir_after_start()

    async def _replay(self, text: str) -> None:
        steps, python_base = parse(text)
        if python_base:
            await self._run_checked(f"sudo dot-install {' '.join(PYTHON_PACKAGES)}", "install Python for a python: base")
        for step in steps:
            if step.kind == "workdir":
                target = step.value if step.value.startswith("/") else posixpath.join(self._workdir, step.value)
                await self._run_checked(f"mkdir -p {shlex.quote(target)}", f"WORKDIR {target}")
                self._workdir = target
            elif step.kind == "env":
                # Double quotes, so that $VARIABLE expands when the file is read, as Docker expands it.
                escaped = step.value.replace("\\", "\\\\").replace('"', '\\"').replace("`", "\\`")
                line = f'export {step.target}="{escaped}"'
                await self._run_checked(f"cat >> {ENV_FILE} <<'ENV_LINE'\n{line}\nENV_LINE", f"ENV {step.target}")
            elif step.kind == "copy":
                for source in step.sources:
                    local = self.environment_dir / source
                    target = step.target if step.target.startswith("/") else posixpath.join(self._workdir, step.target)
                    if local.is_dir():
                        await self.upload_dir(local, target)
                    else:
                        into = target.endswith("/") or len(step.sources) > 1
                        await self.upload_file(local, posixpath.join(target, local.name) if into else target)
            else:
                await self._run_checked(step.value, f"RUN {step.value[:120]}", timeout_sec=3600)

    async def _run_checked(self, command: str, what: str, timeout_sec: int = 900) -> None:
        result = await self.exec(command, timeout_sec=timeout_sec)
        if result.return_code != 0:
            raise RuntimeError(f"{what}: exit {result.return_code}: {(result.stderr or '')[-1500:]}{(result.stdout or '')[-500:]}")

    async def stop(self, delete: bool):
        if self.dot_id is None:
            return
        if delete:
            await bridge.call("delete", self.dot_id)
            self.dot_id = None

    # --- commands and files -------------------------------------------------

    def _dot(self) -> str:
        if self.dot_id is None:
            raise RuntimeError("the Dot is not started")
        return self.dot_id

    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> ExecResult:
        # Every command runs as dot, whatever user is asked for: there is no other in reach.
        merged = self._merge_env(env) or {}
        exports = "".join(f"export {name}={shlex.quote(map_paths(value))}; " for name, value in merged.items())
        directory = map_path(cwd) if cwd else self._workdir
        script = (
            f"set -a; . {ENV_FILE} 2>/dev/null; set +a; {exports}"
            f"mkdir -p {shlex.quote(directory)} && cd {shlex.quote(directory)} && {{ {map_paths(command)}\n}}"
        )
        timeout_ms = min(3_600_000, max(1, int((timeout_sec or 3600) * 1000)))
        result = await bridge.call("exec", self._dot(), str(timeout_ms), stdin=script.encode())
        return_code = result["exit_code"] if not result["timed_out"] else 124
        return ExecResult(stdout=result["stdout"], stderr=result["stderr"], return_code=return_code)

    async def upload_file(self, source_path: Path | str, target_path: str):
        content = map_file(Path(source_path).read_bytes())
        target = map_path(target_path)
        await self._run_checked(f"mkdir -p {shlex.quote(posixpath.dirname(target))}", f"make {posixpath.dirname(target)}")
        await bridge.call("put", self._dot(), target, stdin=content)
        if os.access(source_path, os.X_OK) or str(target).endswith(".sh"):
            await self._run_checked(f"chmod +x {shlex.quote(target)}", f"chmod {target}")

    async def upload_dir(self, source_dir: Path | str, target_dir: str):
        target = map_path(str(target_dir))
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            for path in sorted(Path(source_dir).rglob("*")):
                relative = path.relative_to(source_dir).as_posix()
                info = archive.gettarinfo(str(path), arcname=relative)
                if path.is_file():
                    content = map_file(path.read_bytes())
                    info.size = len(content)
                    archive.addfile(info, io.BytesIO(content))
                elif path.is_dir():
                    archive.addfile(info)
        staged = f"{BENCH_HOME}/.upload-{hashlib.sha256(target.encode()).hexdigest()[:8]}.tar"
        await bridge.call("put", self._dot(), staged, stdin=buffer.getvalue())
        await self._run_checked(
            f"mkdir -p {shlex.quote(target)} && tar -xf {staged} -C {shlex.quote(target)} --no-same-owner && rm -f {staged}",
            f"unpack into {target}",
        )

    async def download_file(self, source_path: str, target_path: Path | str):
        content = await bridge.call("get", self._dot(), map_path(source_path), raw=True)
        Path(target_path).parent.mkdir(parents=True, exist_ok=True)
        Path(target_path).write_bytes(content)

    async def download_dir(self, source_dir: str, target_dir: Path | str):
        source = map_path(str(source_dir))
        staged = f"{BENCH_HOME}/.download-{hashlib.sha256(source.encode()).hexdigest()[:8]}.tar"
        await self._run_checked(f"mkdir -p {shlex.quote(source)} && tar -cf {staged} -C {shlex.quote(source)} .", f"pack {source}")
        content = await bridge.call("get", self._dot(), staged, raw=True)
        await self.exec(f"rm -f {staged}")
        Path(target_dir).mkdir(parents=True, exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(content), mode="r") as archive:
            archive.extractall(target_dir, filter="data")

    def workdir_path(self) -> PurePosixPath:
        return PurePosixPath(self._workdir)
