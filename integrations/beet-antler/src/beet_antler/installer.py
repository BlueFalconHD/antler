import hashlib
import json
import os
import re
import subprocess
import tarfile
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

from .platforms import ReleaseTarget, detect_target

GITHUB_API = "https://api.github.com/repos/BlueFalconHD/antler"
SAFE_TAG = re.compile(r"^v?[A-Za-z0-9][A-Za-z0-9._-]*$")
Fetcher = Callable[[str], bytes]


class AntlerInstallError(RuntimeError):
    pass


@dataclass(frozen=True)
class ReleaseAsset:
    name: str
    url: str


@dataclass(frozen=True)
class Release:
    tag: str
    assets: dict[str, ReleaseAsset]

    @classmethod
    def from_json(cls, value: Any) -> Release:
        if not isinstance(value, dict) or not isinstance(value.get("tag_name"), str):
            raise AntlerInstallError("GitHub returned malformed Antler release metadata")
        tag = validate_tag(value["tag_name"])
        assets: dict[str, ReleaseAsset] = {}
        for item in value.get("assets", []):
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            url = item.get("browser_download_url")
            if isinstance(name, str) and isinstance(url, str):
                validate_download_url(url)
                assets[name] = ReleaseAsset(name, url)
        return cls(tag, assets)

    def to_json(self) -> dict[str, Any]:
        return {
            "tag_name": self.tag,
            "assets": [{"name": asset.name, "browser_download_url": asset.url} for asset in self.assets.values()],
        }


class AntlerInstaller:
    def __init__(
        self,
        cache_directory: Path,
        *,
        latest_check_hours: int = 24,
        fetcher: Fetcher | None = None,
    ):
        self.cache_directory = cache_directory.resolve()
        self.latest_timeout = timedelta(hours=latest_check_hours)
        self.fetcher = fetcher or fetch_url

    def ensure(self, version: str = "latest", target: ReleaseTarget | None = None) -> Path:
        target = target or detect_target()
        release: Release | None = None
        if version == "latest":
            tag, checked_at = self._read_latest()
            if not tag or not checked_at or datetime.now(UTC) - checked_at >= self.latest_timeout:
                try:
                    release = self._fetch_release(f"{GITHUB_API}/releases/latest")
                    tag = release.tag
                    self._write_release(release)
                    write_json_atomic(
                        self.cache_directory / "latest.json",
                        {"tag": tag, "checked_at": datetime.now(UTC).isoformat()},
                    )
                except Exception as error:
                    if tag and (cached := self._verified_cached_executable(tag, target)):
                        return cached
                    if isinstance(error, AntlerInstallError):
                        raise
                    raise AntlerInstallError(f"Unable to resolve the latest Antler release: {error}") from error
            assert tag
        else:
            tag = validate_tag(version if version.startswith("v") else f"v{version}")

        if cached := self._verified_cached_executable(tag, target):
            return cached
        release = release or self._read_release(tag)
        if not release:
            endpoint = f"{GITHUB_API}/releases/tags/{quote(tag, safe='')}"
            release = self._fetch_release(endpoint)
            if release.tag != tag:
                raise AntlerInstallError(f"Requested Antler {tag}, but GitHub returned {release.tag}")
            self._write_release(release)
        return self._install(release, target)

    def _install(self, release: Release, target: ReleaseTarget) -> Path:
        archive_asset = release.assets.get(target.asset_name)
        checksums_asset = release.assets.get("SHA256SUMS")
        if not archive_asset or not checksums_asset:
            raise AntlerInstallError(f"Antler {release.tag} doesn't contain {target.asset_name} and SHA256SUMS")

        directory = self._target_directory(release.tag, target)
        directory.mkdir(parents=True, exist_ok=True)
        archive = directory / target.asset_name
        write_bytes_atomic(archive, self.fetcher(archive_asset.url))
        checksums = self.fetcher(checksums_asset.url).decode("utf8")
        expected_checksum = checksum_for(checksums, target.asset_name)
        actual_checksum = sha256_file(archive)
        if actual_checksum != expected_checksum:
            archive.unlink(missing_ok=True)
            raise AntlerInstallError(
                f"Checksum mismatch for {target.asset_name}: expected {expected_checksum}, got {actual_checksum}"
            )

        executable = directory / target.executable_name
        contents = extract_executable(archive, target.executable_name)
        write_bytes_atomic(executable, contents, mode=0o755 if os.name != "nt" else 0o700)
        try:
            validate_executable_version(executable, release.tag)
        except Exception:
            executable.unlink(missing_ok=True)
            raise
        write_json_atomic(
            directory / "install.json",
            {
                "tag": release.tag,
                "target": target.name,
                "asset": target.asset_name,
                "archive_sha256": actual_checksum,
                "executable_sha256": sha256_file(executable),
            },
        )
        return executable

    def _verified_cached_executable(self, tag: str, target: ReleaseTarget) -> Path | None:
        directory = self._target_directory(tag, target)
        executable = directory / target.executable_name
        manifest = read_json(directory / "install.json")
        if (
            not executable.is_file()
            or not isinstance(manifest, dict)
            or manifest.get("tag") != tag
            or manifest.get("target") != target.name
            or manifest.get("executable_sha256") != sha256_file(executable)
        ):
            return None
        try:
            validate_executable_version(executable, tag)
        except AntlerInstallError:
            return None
        return executable

    def _target_directory(self, tag: str, target: ReleaseTarget) -> Path:
        return self.cache_directory / "releases" / validate_tag(tag) / target.name

    def _fetch_release(self, url: str) -> Release:
        try:
            return Release.from_json(json.loads(self.fetcher(url)))
        except AntlerInstallError:
            raise
        except Exception as error:
            raise AntlerInstallError(f"Unable to download Antler release metadata: {error}") from error

    def _release_path(self, tag: str) -> Path:
        return self.cache_directory / "releases" / validate_tag(tag) / "release.json"

    def _read_release(self, tag: str) -> Release | None:
        value = read_json(self._release_path(tag))
        if value is None:
            return None
        try:
            return Release.from_json(value)
        except AntlerInstallError:
            return None

    def _write_release(self, release: Release) -> None:
        write_json_atomic(self._release_path(release.tag), release.to_json())

    def _read_latest(self) -> tuple[str | None, datetime | None]:
        value = read_json(self.cache_directory / "latest.json")
        if not isinstance(value, dict) or not isinstance(value.get("tag"), str):
            return None, None
        try:
            return validate_tag(value["tag"]), datetime.fromisoformat(value["checked_at"])
        except AntlerInstallError, KeyError, TypeError, ValueError:
            return None, None


def fetch_url(url: str) -> bytes:
    request = Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "beet-antler",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urlopen(request, timeout=60) as response:
        return response.read()


def validate_tag(tag: str) -> str:
    if not SAFE_TAG.fullmatch(tag):
        raise AntlerInstallError("Antler release tag contains unsafe characters")
    return tag


def validate_download_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != "github.com":
        raise AntlerInstallError("Antler release assets must use an HTTPS github.com URL")


def checksum_for(contents: str, filename: str) -> str:
    for line in contents.splitlines():
        pieces = line.split(maxsplit=1)
        if len(pieces) == 2 and pieces[1].lstrip("*") == filename and re.fullmatch(r"[0-9a-fA-F]{64}", pieces[0]):
            return pieces[0].lower()
    raise AntlerInstallError(f"SHA256SUMS doesn't contain {filename}")


def extract_executable(archive: Path, executable_name: str) -> bytes:
    if archive.name.endswith(".tar.gz"):
        with tarfile.open(archive, "r:gz") as bundle:
            members = [
                member
                for member in bundle.getmembers()
                if member.isfile() and PurePosixPath(member.name).name == executable_name
            ]
            if len(members) != 1:
                raise AntlerInstallError(f"Archive must contain exactly one {executable_name}")
            extracted = bundle.extractfile(members[0])
            if not extracted:
                raise AntlerInstallError(f"Unable to read {executable_name} from archive")
            return extracted.read()
    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as bundle:
            members = [name for name in bundle.namelist() if PurePosixPath(name).name == executable_name]
            if len(members) != 1:
                raise AntlerInstallError(f"Archive must contain exactly one {executable_name}")
            return bundle.read(members[0])
    raise AntlerInstallError(f"Unsupported Antler archive: {archive.name}")


def validate_executable_version(executable: Path, tag: str) -> None:
    try:
        result = subprocess.run(
            [executable, "--version"],
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise AntlerInstallError(f"Downloaded Antler executable failed validation: {error}") from error
    if result.stdout.strip().removeprefix("v") != tag.removeprefix("v"):
        raise AntlerInstallError(
            f"Downloaded Antler reports {result.stdout.strip()!r}, expected {tag.removeprefix('v')!r}"
        )


def sha256_file(filename: Path) -> str:
    digest = hashlib.sha256()
    with filename.open("rb") as fileobj:
        for chunk in iter(lambda: fileobj.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(filename: Path) -> Any:
    try:
        return json.loads(filename.read_text("utf8"))
    except OSError, ValueError:
        return None


def write_json_atomic(filename: Path, value: Any) -> None:
    write_bytes_atomic(filename, f"{json.dumps(value, indent=2)}\n".encode())


def write_bytes_atomic(filename: Path, contents: bytes, mode: int = 0o600) -> None:
    filename.parent.mkdir(parents=True, exist_ok=True)
    temporary = filename.with_name(f".{filename.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("wb") as fileobj:
            fileobj.write(contents)
            fileobj.flush()
            os.fsync(fileobj.fileno())
        temporary.chmod(mode)
        temporary.replace(filename)
    finally:
        temporary.unlink(missing_ok=True)
