import type { Attributes, FileEntry } from "ssh2";
import { FilePermission, FileType, type RemoteStat } from "../vscode/remoteFileSystem.js";

const TYPE_FILE = 0o100000;
const TYPE_DIRECTORY = 0o040000;
const TYPE_SYMLINK = 0o120000;

export function toAttributes(stat: RemoteStat): Attributes {
  let mode: number;
  if ((stat.type & FileType.SymbolicLink) !== 0) {
    mode = TYPE_SYMLINK | 0o777;
  } else if ((stat.type & FileType.Directory) !== 0) {
    mode = TYPE_DIRECTORY | 0o755;
  } else {
    mode = TYPE_FILE | 0o644;
  }
  if (stat.permissions === FilePermission.Locked) {
    mode &= ~0o222;
  }
  return {
    mode,
    uid: 0,
    gid: 0,
    size: stat.size,
    atime: Math.floor(stat.mtime / 1000),
    mtime: Math.floor(stat.mtime / 1000),
  };
}

export function stagedAttributes(stat: { size: number; mtimeMs: number }): Attributes {
  return {
    mode: TYPE_FILE | 0o600,
    uid: 0,
    gid: 0,
    size: stat.size,
    atime: Math.floor(stat.mtimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000),
  };
}

export function symlinkListingAttributes(): Attributes {
  return { mode: TYPE_SYMLINK | 0o777, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 };
}

export function toFileEntry(filename: string, attrs: Attributes): FileEntry {
  const type = (attrs.mode & TYPE_DIRECTORY) === TYPE_DIRECTORY ? "d" : (attrs.mode & TYPE_SYMLINK) === TYPE_SYMLINK ? "l" : "-";
  const bits = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];
  const letters = ["r", "w", "x", "r", "w", "x", "r", "w", "x"];
  const permissions = bits.map((bit, index) => ((attrs.mode & bit) !== 0 ? letters[index] : "-")).join("");
  return {
    filename,
    longname: `${type}${permissions} 1 ${attrs.uid} ${attrs.gid} ${attrs.size} ${filename}`,
    attrs,
  };
}
