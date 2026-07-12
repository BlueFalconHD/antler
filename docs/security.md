# Security model

## Trust boundaries

- The configured code-server TLS endpoint and its remote operating system are
  trusted.
- The local user can read the local working tree, `.moose_proxy` recovery
  objects, configured password file, and this process's memory.
- Local and remote filesystem events are untrusted hints. Every path is parsed
  and confined again before any operation.
- Other processes on either filesystem are trusted not to replace a checked
  directory component with a symlink during the small check/use race window.

The final assumption exists because VS Code 1.85.2 `remoteFilesystem` does not
provide `openat`, `O_NOFOLLOW`, `realpath`, or `readlink`. The daemon rejects
every visible symlink but cannot make an atomic kernel-level guarantee against
an independently privileged racing process.

## Path confinement

All stored paths are root-relative. Validation rejects:

- absolute paths and drive-letter paths;
- NUL, backslash, and `..` components;
- `.git`, `.moose_proxy`, and internal temporary names at any depth;
- paths outside the configured local or remote root;
- symlinks and non-file/non-directory special entries.

The remote root must be an absolute POSIX directory other than `/`. Every
ancestor from remote `/` through the configured root is statted at connection
time and must be a real directory. Parent components are checked again before
reads, writes, directory creation, and deletion. The local root and state
directory must also be non-symlink directories.

The provider reports a symlink bit only after following in some cases, so the
daemon deliberately refuses all symlink entries instead of attempting to
support safe in-root links.

## Data-loss defenses

- First synchronization has no implicit winner.
- Different common files and delete-versus-modify cases become conflicts.
- Deletions require explicit approval and are protected by count/percentage
  circuit breakers.
- The last synchronized base content is retained in a SHA-256-addressed local
  object store.
- Inbound overwrites and local deletions require a Git checkpoint when Git
  checkpointing is available.
- Writes use unpredictable same-directory temporary files and atomic rename.
- State is written to a temporary 0600 file, flushed, and atomically renamed.
- Mutations are journaled before side effects. A nonempty journal forces a full
  scan; uncertain operations are inspected rather than blindly replayed.
- Watcher events are coalesced but never used as the sole source of truth.
  Startup, reconnect, watcher errors, and periodic intervals trigger full
  reconciliation.

The state directory itself is hard-excluded in code, independent of ignore
configuration. A missing or malformed state file fails closed.

## Credentials and transport

- TLS verification is on by default.
- The password is accepted only from a hidden TTY prompt,
  `MOOSE_PROXY_CODE_SERVER_PASSWORD`, or a protected regular file.
- Password contents and the code-server session cookie remain in memory and
  are never persisted.
- The optional password-file path is non-secret and may be saved in config.
- Prefix-aware login cookies, WebSocket Origin, product commit, and stable route
  are matched to the pinned public implementation.
- Logs redact credential/authorization fields and never contain file contents.
- No local network listener exists.
- Only management-channel `remoteFilesystem` calls and events are exposed.
- The interactive shell recognizes a fixed command set and never evaluates
  environment variables, substitutions, pipelines, or operating-system
  commands. Quoting affects token boundaries only.

`--insecure-skip-tls-verify`, `--omit-origin`, and
`--allow-version-mismatch` are explicit compatibility/development escape
hatches saved in the project config. They should not be used to hide an
unexplained production mismatch.

## Local recovery data

`.moose_proxy/objects` and `.moose_proxy/conflicts` can contain previous file
contents. The directory is mode 0700 and files are 0600, but this is not
encryption. Use an encrypted local volume if the project requires encryption
at rest.

Temporary remote files use `.moose_proxy-tmp-<uuid>`. They are excluded from
watch processing and removed on ordinary failure. A machine crash can leave
one behind; it never replaces the original until the final rename succeeds.
