from typing import Literal

from beet import PluginOptions
from pydantic import Field, field_validator


class AntlerOptions(PluginOptions):
    version: str = "latest"
    sync: Literal["auto"] | bool = "auto"
    sync_root: str | None = None
    remote_root: str | None = None
    approve_deletes: bool = False
    latest_check_hours: int = Field(default=24, ge=1)

    @field_validator("version")
    @classmethod
    def validate_version(cls, value: str) -> str:
        value = value.strip()
        if not value or (value != "latest" and not value.removeprefix("v").replace(".", "").replace("-", "").isalnum()):
            raise ValueError("version must be 'latest' or a release tag")
        return value
