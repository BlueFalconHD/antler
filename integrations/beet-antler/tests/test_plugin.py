import json
from pathlib import Path

from beet import Project

import beet_antler.plugin as plugin_module
from beet_antler.config import AntlerOptions
from beet_antler.plugin import AntlerOutput, beet_default


class FakeAutosave:
    def __init__(self):
        self.handlers = []

    def add_output(self, handler):
        self.handlers.append(handler)


class FakeContext:
    def __init__(self, root: Path):
        self.directory = root
        self.output_directory = root / "dist"
        self.autosave = FakeAutosave()

    def validate(self, key, model):
        assert key == "antler"
        return model()

    def inject(self, cls):
        return self.autosave


def test_registers_as_an_autosave_output_handler(tmp_path: Path):
    ctx = FakeContext(tmp_path)

    beet_default(ctx)  # type: ignore[arg-type]

    assert len(ctx.autosave.handlers) == 1
    assert isinstance(ctx.autosave.handlers[0], AntlerOutput)


def test_defaults_sync_root_to_beet_output(tmp_path: Path):
    ctx = FakeContext(tmp_path)
    handler = AntlerOutput(AntlerOptions())

    assert handler._sync_root(ctx) == tmp_path / "dist"  # type: ignore[arg-type]


def test_beet_runs_antler_handler_after_writing_output(tmp_path: Path, monkeypatch):
    (tmp_path / "build_plugins.py").write_text(
        "from beet import Function\ndef add_pack(ctx):\n    ctx.data['demo:hello'] = Function(['say hello'])\n"
    )
    (tmp_path / "beet.json").write_text(
        json.dumps(
            {
                "name": "demo",
                "output": "dist",
                "pipeline": ["build_plugins.add_pack", "beet_antler"],
                "meta": {"antler": {"sync": False}},
            }
        )
    )
    observed_output: list[bool] = []

    class FakeInstaller:
        def __init__(self, *args, **kwargs):
            pass

        def ensure(self, version):
            observed_output.append(any((tmp_path / "dist").rglob("pack.mcmeta")))
            return tmp_path / "cached-antler"

    monkeypatch.setattr(plugin_module, "AntlerInstaller", FakeInstaller)

    Project(config_path=tmp_path / "beet.json").build()

    assert observed_output == [True]
