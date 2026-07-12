import pytest

from beet_antler.platforms import detect_target


@pytest.mark.parametrize(
    ("system", "machine", "asset"),
    [
        ("Linux", "AMD64", "antler-linux-x64.tar.gz"),
        ("Darwin", "arm64", "antler-macos-arm64.tar.gz"),
        ("Darwin", "x86_64", "antler-macos-x64.tar.gz"),
        ("Windows", "x64", "antler-windows-x64.zip"),
    ],
)
def test_selects_release_asset(system: str, machine: str, asset: str):
    assert detect_target(system, machine).asset_name == asset


def test_rejects_unsupported_platform():
    with pytest.raises(RuntimeError, match="doesn't publish"):
        detect_target("Linux", "arm64")
