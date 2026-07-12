import json
from collections.abc import Mapping, Sequence
from pathlib import Path

import pytest

from beet_antler.config import AntlerOptions
from beet_antler.runner import AntlerInvocationError, AntlerRunner


class CommandRecorder:
    def __init__(self):
        self.calls: list[tuple[list[str], Path, dict[str, str]]] = []

    def __call__(self, arguments: Sequence[str], cwd: Path, environment: Mapping[str, str]) -> None:
        self.calls.append((list(arguments), cwd, dict(environment)))


def test_auto_mode_skips_unconfigured_project(tmp_path: Path):
    sync_root = make_sync_root(tmp_path)
    commands = CommandRecorder()

    result = AntlerRunner(
        tmp_path / "antler",
        tmp_path,
        sync_root,
        AntlerOptions(),
        environment={},
        run_command=commands,
    ).run()

    assert result == "skipped"
    assert not commands.calls


def test_initializes_noninteractively_from_environment(tmp_path: Path):
    sync_root = make_sync_root(tmp_path)
    commands = CommandRecorder()
    environment = {
        "ANTLER_CODE_SERVER_URL": "https://code.example.test/instance/?folder=/srv/datapack",
        "ANTLER_CODE_SERVER_PASSWORD": "secret",
    }

    result = AntlerRunner(
        tmp_path / "antler",
        tmp_path,
        sync_root,
        AntlerOptions(),
        environment=environment,
        run_command=commands,
    ).run()

    assert result == "initialized"
    arguments, cwd, invoked_environment = commands.calls[0]
    assert arguments[-4:] == ["init", str(tmp_path), "--sync-root", "dist"]
    assert "secret" not in arguments
    assert cwd == tmp_path
    assert invoked_environment["ANTLER_CODE_SERVER_PASSWORD"] == "secret"
    assert invoked_environment["NO_COLOR"] == "1"


def test_synchronizes_existing_matching_project(tmp_path: Path):
    sync_root = make_sync_root(tmp_path)
    write_config(tmp_path, "dist")
    commands = CommandRecorder()

    result = AntlerRunner(
        tmp_path / "antler",
        tmp_path,
        sync_root,
        AntlerOptions(approve_deletes=True),
        environment={"ANTLER_CODE_SERVER_PASSWORD": "secret"},
        run_command=commands,
    ).run()

    assert result == "synchronized"
    assert commands.calls[0][0][-3:] == ["sync", str(tmp_path), "--approve-deletes"]


def test_refuses_to_rebind_existing_project(tmp_path: Path):
    sync_root = make_sync_root(tmp_path)
    write_config(tmp_path, ".")

    with pytest.raises(AntlerInvocationError, match="won't rebind"):
        AntlerRunner(
            tmp_path / "antler",
            tmp_path,
            sync_root,
            AntlerOptions(),
            environment={"ANTLER_CODE_SERVER_PASSWORD": "secret"},
        ).run()


def test_rejects_partial_initialization_credentials(tmp_path: Path):
    sync_root = make_sync_root(tmp_path)

    with pytest.raises(AntlerInvocationError, match="both required"):
        AntlerRunner(
            tmp_path / "antler",
            tmp_path,
            sync_root,
            AntlerOptions(),
            environment={"ANTLER_CODE_SERVER_PASSWORD": "secret"},
        ).run()


def make_sync_root(project_root: Path) -> Path:
    sync_root = project_root / "dist"
    sync_root.mkdir()
    return sync_root


def write_config(project_root: Path, sync_root: str) -> None:
    state = project_root / ".antler"
    state.mkdir()
    (state / "config.json").write_text(json.dumps({"schemaVersion": 3, "local": {"root": sync_root}}))
