import platform
from dataclasses import dataclass


@dataclass(frozen=True)
class ReleaseTarget:
    name: str
    asset_name: str
    executable_name: str


TARGETS = {
    ("linux", "x86_64"): ReleaseTarget("linux-x64", "antler-linux-x64.tar.gz", "antler"),
    ("darwin", "x86_64"): ReleaseTarget("macos-x64", "antler-macos-x64.tar.gz", "antler"),
    ("darwin", "arm64"): ReleaseTarget("macos-arm64", "antler-macos-arm64.tar.gz", "antler"),
    ("windows", "x86_64"): ReleaseTarget("windows-x64", "antler-windows-x64.zip", "antler.exe"),
}


def detect_target(system: str | None = None, machine: str | None = None) -> ReleaseTarget:
    normalized_system = (system or platform.system()).lower()
    normalized_machine = (machine or platform.machine()).lower()
    normalized_machine = {
        "amd64": "x86_64",
        "x64": "x86_64",
        "aarch64": "arm64",
    }.get(normalized_machine, normalized_machine)
    try:
        return TARGETS[(normalized_system, normalized_machine)]
    except KeyError as error:
        raise RuntimeError(f"Antler doesn't publish a binary for {normalized_system}/{normalized_machine}") from error
