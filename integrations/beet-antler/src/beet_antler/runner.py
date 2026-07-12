import json
import os
import subprocess
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .config import AntlerOptions

RunCommand = Callable[[Sequence[str], Path, Mapping[str, str]], None]


class AntlerInvocationError(RuntimeError):
    pass


class AntlerRunner:
    def __init__(
        self,
        executable: Path,
        project_root: Path,
        sync_root: Path,
        options: AntlerOptions,
        *,
        environment: Mapping[str, str] | None = None,
        run_command: RunCommand | None = None,
    ):
        self.executable = executable.resolve()
        self.project_root = project_root.resolve()
        self.sync_root = sync_root.resolve()
        self.options = options
        self.environment = dict(environment if environment is not None else os.environ)
        self.run_command = run_command or run_subprocess

    def run(self) -> str:
        relative_sync_root = self._relative_sync_root()
        if self.options.sync is False:
            return "disabled"
        if not self.sync_root.is_dir():
            raise AntlerInvocationError(f"Antler sync root doesn't exist after Beet output: {self.sync_root}")

        config_path = self.project_root / ".antler" / "config.json"
        if config_path.is_file():
            self._validate_existing_config(config_path, relative_sync_root)
            if not self.environment.get("ANTLER_CODE_SERVER_PASSWORD"):
                if self.options.sync == "auto":
                    return "skipped"
                raise AntlerInvocationError("ANTLER_CODE_SERVER_PASSWORD is required to synchronize")
            arguments = self._base_arguments() + ["sync", str(self.project_root)]
            if self.options.approve_deletes:
                arguments.append("--approve-deletes")
            self._invoke(arguments)
            return "synchronized"

        state_directory = self.project_root / ".antler"
        if state_directory.exists():
            raise AntlerInvocationError(f"{state_directory} exists without a usable config.json")

        url = self.environment.get("ANTLER_CODE_SERVER_URL")
        password = self.environment.get("ANTLER_CODE_SERVER_PASSWORD")
        if not url and not password and self.options.sync == "auto":
            return "skipped"
        if not url or not password:
            raise AntlerInvocationError(
                "ANTLER_CODE_SERVER_URL and ANTLER_CODE_SERVER_PASSWORD are both required for automatic setup"
            )
        if not self._remote_root_available(url):
            raise AntlerInvocationError(
                "ANTLER_CODE_SERVER_URL must contain the folder query parameter, or a remote root must be configured"
            )

        arguments = self._base_arguments() + [
            "init",
            str(self.project_root),
            "--sync-root",
            relative_sync_root,
        ]
        if self.options.remote_root:
            arguments.extend(["--remote-root", self.options.remote_root])
        self._invoke(arguments)
        return "initialized"

    def _relative_sync_root(self) -> str:
        try:
            relative = self.sync_root.relative_to(self.project_root)
        except ValueError as error:
            raise AntlerInvocationError("The Beet output directory must be inside the project root") from error
        return relative.as_posix() or "."

    def _validate_existing_config(self, config_path: Path, relative_sync_root: str) -> None:
        try:
            config = json.loads(config_path.read_text("utf8"))
            configured_root = config["local"]["root"]
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise AntlerInvocationError(f"Unable to validate existing Antler config: {error}") from error
        if configured_root != relative_sync_root:
            raise AntlerInvocationError(
                f"Existing Antler sync root is {configured_root!r}, but Beet outputs to {relative_sync_root!r}; "
                "Antler won't rebind an existing project automatically"
            )

    def _remote_root_available(self, url: str) -> bool:
        return bool(
            parse_qs(urlparse(url).query).get("folder")
            or self.options.remote_root
            or self.environment.get("ANTLER_REMOTE_ROOT")
        )

    def _base_arguments(self) -> list[str]:
        return [str(self.executable), "--format", "plain", "--no-color"]

    def _invoke(self, arguments: Sequence[str]) -> None:
        environment = {**self.environment, "NO_COLOR": "1"}
        try:
            self.run_command(arguments, self.project_root, environment)
        except (OSError, subprocess.SubprocessError) as error:
            raise AntlerInvocationError(f"Antler command failed: {error}") from error


def run_subprocess(arguments: Sequence[str], cwd: Path, environment: Mapping[str, str]) -> None:
    subprocess.run(
        list(arguments),
        cwd=cwd,
        env=dict(environment),
        stdin=subprocess.DEVNULL,
        check=True,
    )
