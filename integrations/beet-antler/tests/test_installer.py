import hashlib
import io
import json
import tarfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from beet_antler.installer import AntlerInstaller, AntlerInstallError
from beet_antler.platforms import ReleaseTarget

TARGET = ReleaseTarget("test-x64", "antler-test-x64.tar.gz", "antler")
LATEST_URL = "https://api.github.com/repos/BlueFalconHD/antler/releases/latest"
ARCHIVE_URL = "https://github.com/BlueFalconHD/antler/releases/download/v0.1.2/antler-test-x64.tar.gz"
CHECKSUM_URL = "https://github.com/BlueFalconHD/antler/releases/download/v0.1.2/SHA256SUMS"


class FakeFetcher:
    def __init__(self, responses: dict[str, bytes]):
        self.responses = responses
        self.calls: list[str] = []

    def __call__(self, url: str) -> bytes:
        self.calls.append(url)
        try:
            return self.responses[url]
        except KeyError as error:
            raise OSError(f"offline: {url}") from error


def test_downloads_verifies_and_reuses_latest_release(tmp_path: Path):
    archive = executable_archive("0.1.2")
    fetcher = FakeFetcher(release_responses(archive))
    installer = AntlerInstaller(tmp_path, fetcher=fetcher)

    executable = installer.ensure("latest", TARGET)
    initial_calls = list(fetcher.calls)

    assert executable.is_file()
    assert executable.stat().st_mode & 0o111
    assert installer.ensure("latest", TARGET) == executable
    assert fetcher.calls == initial_calls


def test_fails_closed_on_checksum_mismatch(tmp_path: Path):
    archive = executable_archive("0.1.2")
    responses = release_responses(archive)
    responses[CHECKSUM_URL] = f"{'0' * 64}  {TARGET.asset_name}\n".encode()

    with pytest.raises(AntlerInstallError, match="Checksum mismatch"):
        AntlerInstaller(tmp_path, fetcher=FakeFetcher(responses)).ensure("latest", TARGET)

    assert not (tmp_path / "releases" / "v0.1.2" / TARGET.name / TARGET.executable_name).exists()


def test_uses_verified_cached_latest_when_refresh_is_offline(tmp_path: Path):
    archive = executable_archive("0.1.2")
    installer = AntlerInstaller(tmp_path, fetcher=FakeFetcher(release_responses(archive)))
    executable = installer.ensure("latest", TARGET)
    (tmp_path / "latest.json").write_text(
        json.dumps({"tag": "v0.1.2", "checked_at": (datetime.now(UTC) - timedelta(days=2)).isoformat()})
    )
    offline = FakeFetcher({})

    assert AntlerInstaller(tmp_path, fetcher=offline).ensure("latest", TARGET) == executable
    assert offline.calls == [LATEST_URL]


def executable_archive(version: str) -> bytes:
    script = f'#!/bin/sh\nif [ "$1" = "--version" ]; then echo "{version}"; fi\n'.encode()
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as bundle:
        member = tarfile.TarInfo("antler")
        member.size = len(script)
        member.mode = 0o755
        bundle.addfile(member, io.BytesIO(script))
    return output.getvalue()


def release_responses(archive: bytes) -> dict[str, bytes]:
    release = {
        "tag_name": "v0.1.2",
        "assets": [
            {"name": TARGET.asset_name, "browser_download_url": ARCHIVE_URL},
            {"name": "SHA256SUMS", "browser_download_url": CHECKSUM_URL},
        ],
    }
    return {
        LATEST_URL: json.dumps(release).encode(),
        ARCHIVE_URL: archive,
        CHECKSUM_URL: f"{hashlib.sha256(archive).hexdigest()}  {TARGET.asset_name}\n".encode(),
    }
