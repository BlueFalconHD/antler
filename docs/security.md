# Security model

## Trust boundaries

- The code-server TLS endpoint and its host operating system are trusted.
- The local user running the bridge can read its process memory, secret files,
  host key, and staging files.
- SFTP clients are untrusted and are confined to the configured remote root.
- Other processes already running on the remote host are trusted not to race
  filesystem path components during an operation.

The last assumption is necessary because VS Code 1.85.2 `remoteFilesystem`
does not expose `openat`, `O_NOFOLLOW`, `realpath`, or `readlink`. It cannot
provide atomic race protection against an independently privileged remote
process replacing a checked directory with a symlink. SFTP clients cannot
create or traverse symlinks through this bridge.

## Confinement

Every source and destination path is independently checked before URI creation:

- the remote root must be an absolute POSIX path;
- NUL, backslash, and any `..` segment are rejected before normalization;
- SFTP absolute paths are interpreted only in the virtual namespace rooted at
  `/`, never as remote host absolute paths;
- the mapped path must equal the root or have the root plus `/` as its prefix;
- every existing component from remote `/` through the final entry is statted;
- any component with `FileType.SymbolicLink` is denied;
- create operations permit only a missing final component;
- rename applies the full check to both source and destination;
- the configured root itself cannot be deleted, replaced, or renamed.

Symlinks are deliberately unusable, including links whose current target would
remain within the root. The provider's stat follows links before reporting the
symlink bit, so true LSTAT of a symlink cannot be provided without risking an
out-of-root metadata read.

## Credentials and transport

- TLS verification defaults on. Insecure TLS requires a conspicuous explicit
  flag and is logged.
- The password login cookie is scoped by code-server's prefix-aware login flow.
- Passwords and cookies are excluded from logs; no authorization data or file
  contents are logged.
- code-server password and cookie are never written by the bridge.
- Password files must be protected regular files and cannot be symlinks.
- The local SSH endpoint always requires authentication and uses a persistent
  configurable host key.
- Non-loopback binding is refused without explicit opt-in.
- Only the VS Code management connection and `remoteFilesystem` calls are
  implemented. Tunnel, extension-host, terminal, command, and extension APIs
  are not exposed.

## Local staged data

Offset writes require local staging because upstream only offers truncating
write-open. The staging directory must be a non-symlink directory without
group/other permissions; files use mode 0600 and are removed on close, abort,
session cleanup, or connection loss. Sudden process or machine failure can
leave a local staging file or an unpredictable `.moose-proxy-*.tmp` file in the
remote destination directory, so use an encrypted local volume when file
content requires encryption at rest and remove abandoned temporary files after
a crash.

## Unsupported behavior

Unknown or unsupported requests return SFTP failure or OP_UNSUPPORTED. The
bridge never returns success for chmod, chown, timestamp changes, link
operations, extensions, recursive deletion, or overwriting SFTP RENAME.
