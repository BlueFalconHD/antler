import logging
from dataclasses import dataclass
from pathlib import Path

from beet import Context
from beet.contrib.autosave import Autosave

from .config import AntlerOptions
from .installer import AntlerInstaller
from .runner import AntlerRunner

logger = logging.getLogger("beet_antler")


@dataclass(eq=False)
class AntlerOutput:
    options: AntlerOptions

    def __call__(self, ctx: Context) -> None:
        cache_directory = ctx.cache["antler"].directory
        executable = AntlerInstaller(
            cache_directory,
            latest_check_hours=self.options.latest_check_hours,
        ).ensure(self.options.version)
        sync_root = self._sync_root(ctx)
        result = AntlerRunner(
            executable,
            ctx.directory,
            sync_root,
            self.options,
        ).run()
        if result == "skipped":
            logger.info("Antler is cached; synchronization was skipped because credentials aren't configured.")
        elif result == "disabled":
            logger.info("Antler is cached; synchronization is disabled.")

    def _sync_root(self, ctx: Context) -> Path:
        if self.options.sync_root:
            configured = Path(self.options.sync_root)
            return configured if configured.is_absolute() else ctx.directory / configured
        if ctx.output_directory:
            return ctx.output_directory
        if self.options.sync is False:
            return ctx.directory
        raise RuntimeError("beet-antler requires a Beet output directory or antler.sync_root")


def beet_default(ctx: Context) -> None:
    options = ctx.validate("antler", AntlerOptions)
    ctx.inject(Autosave).add_output(AntlerOutput(options))
