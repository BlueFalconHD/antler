# Antler

Antler keeps a normal local datapack directory synchronized with its Legitimoose
workspace. Editors, Git, formatters, and build tools use local files; the
foreground daemon transfers only changed files through Legitimoose's
authenticated VS Code `remoteFilesystem` channel.

There is no local SSH/SFTP server, port, host key, or editor extension to
configure.

## Install

Bun 1.3.1 is the pinned development and release tool:

```sh
bun install --frozen-lockfile
bun run check
bun run build:exe
./dist/antler --version
```

`dist/antler` is a [Bun standalone executable](https://bun.sh/docs/bundler/executables)
containing Antler, its dependencies, and the Bun runtime. The destination
machine needs neither Bun nor Node.js.
Copy it somewhere on `PATH`, for example:

```sh
install -m 0755 dist/antler "$HOME/.local/bin/antler"
```

`bun run build` also produces portable Node-compatible JavaScript at
`dist/index.js` for development. The repository directory itself remains named
`moose_proxy`; that path is not part of the product name.

## Connect a project

Create or choose a local directory and paste the complete URL from the browser.
The CLI understands `/login?folder=...` URLs, including path-prefixed
deployments, and infers the remote project root.

```sh
antler init "$HOME/Projects/datapack" \
  --url 'https://code.legitimoose.com/INSTANCE/login?folder=/home/coder/project/datapack&to='
```

The password is requested without echo. It is never accepted as a command-line
value or written to project state. For unattended starts, use
`ANTLER_CODE_SERVER_PASSWORD` or a protected file:

```sh
umask 077
mkdir -p "$HOME/.config/antler"
read -r -s -p 'code-server password: ' CODE_SERVER_PASSWORD; printf '\n'
printf '%s\n' "$CODE_SERVER_PASSWORD" > "$HOME/.config/antler/code-server-password"
unset CODE_SERVER_PASSWORD

antler init "$HOME/Projects/datapack" \
  --url 'https://code.legitimoose.com/INSTANCE/login?folder=/home/coder/project/datapack&to=' \
  --password-file "$HOME/.config/antler/code-server-password"
```

Password files must be regular non-symlink files with mode 0600 or stricter.
The saved configuration contains only the password file's path.

Initialization scans both trees and applies only unambiguous operations:

- a file present on one side is copied to the missing side;
- byte-identical files establish a baseline;
- differing files at the same path become conflicts;
- nothing is deleted during initialization;
- neither version of a conflict is overwritten.

## Live synchronization

```sh
cd "$HOME/Projects/datapack"
antler start
```

Running `antler` with no command also starts the nearest project. The
daemon subscribes to local and remote events, coalesces editor save bursts,
reconciles only affected paths, and performs a full scan after startup,
reconnection, watcher errors, and every 30 seconds as a correctness backstop.

Typical output is intentionally compact:

```text
✓ Connected to Legitimoose 69.0.0  commit=ebeb3c82ac91ac3e453356093435047ed911a179
✓ Remote root confined  remoteRoot=/home/coder/project/datapack
✓ Live synchronization is running
✓ ↑ Uploaded data/example.json  bytes=4312  durationMs=82.1
✓ ↓ Downloaded pack.mcmeta  bytes=187  durationMs=31.4
⚠ Conflict: README.md — neither copy was changed
```

Useful commands:

```sh
antler status
antler sync
antler conflicts
antler resolve README.md --take local
antler checkpoints
antler doctor
```

### One-login interactive shell

Use `sh` when you want to run several control commands without entering the
ephemeral code-server password or rebuilding the WebSocket session each time:

```text
$ antler sh
Code-server password:
✓ Authenticated shell ready  remoteRoot=/home/coder/project/datapack
One login, one remote session. Type `help` for commands.

antler › status
antler › sync
antler › conflicts
antler › resolve "data/file with spaces.json" --take remote
antler › doctor
antler › exit
```

The shell supports `status`, `sync`, `conflicts`, `resolve`, `checkpoints`,
`restore`, `doctor`, and `pwd`. All remote operations share the same in-memory
session cookie and remote-agent connection until `exit`, Ctrl-C, or Ctrl-D.
Command errors return to the prompt instead of dropping authentication.

This is intentionally an Antler control shell, not a local or remote OS
shell: it performs no variable expansion, command substitution, or arbitrary
command execution. `init` creates a different project and `start` is a
continuous foreground daemon, so those remain top-level commands. Use
`antler start` for automatic live synchronization and `antler sh`
for repeated interactive control.

Use `--format json` for machine-readable diagnostics, `--format plain` for
stable uncolored lines, and `--log-level debug` for additional protocol-safe
diagnostics.

## `.antler/` state

Each local root contains a private `.antler/` directory:

```text
.antler/
├── config.json       non-secret connection and policy configuration
├── state.json        baselines, fingerprints, conflicts, deletion intents
├── journal.jsonl     flushed mutation intent log (present only when needed)
├── objects/          content-addressed recovery/base objects
├── conflicts/        human-readable losing versions saved during resolution
└── tmp/              temporary Git indexes
```

It is mode 0700, is hard-excluded from both synchronization directions, and is
added to `.git/info/exclude` when the local root is a Git repository. Passwords
and session cookies never enter it.

Local watcher events for `.git`, `.antler`, and transfer temporary files
are discarded before path normalization, whether macOS reports the event name
as relative or absolute. Updating state therefore cannot trigger a watcher
error or a reconciliation loop.

If this directory is lost, the daemon refuses to start. Re-initialization does
not invent a winner: common files are compared again and differences become
conflicts.

### Migration from the old name

On first use, Antler recognizes an existing `.moose_proxy/` project, atomically
renames it to `.antler/`, and rewrites its non-secret configuration without the
old compatibility-profile field. It never copies or recreates sync baselines.
Stop the old daemon first. If both directories exist, Antler refuses to choose
or merge them. The legacy state and temporary names remain permanently reserved
so they can never leak into the remote datapack.

## Conflicts and deletion safety

The last synchronized content hash is the common base. A local-only edit is
uploaded, a remote-only edit is downloaded, identical simultaneous edits are
re-baselined, and different simultaneous edits are preserved as a conflict.

Deletion propagation is disabled by default. `status` lists pending deletions.
After reviewing them:

```sh
antler sync --approve-deletes
```

More than 20 deletions or 10% of tracked paths trips a circuit breaker. An
intentional larger batch additionally requires `--force-large-delete`.
Deletion versus modification always becomes a conflict, never a deletion.
An unambiguous file rename whose content still matches its stored base is
propagated as a rename and does not require deletion approval. Ambiguous
same-content rename candidates remain ordinary create plus pending delete.

Writes use a sibling temporary file, flush it, verify size/type, then rename it
over the destination. A durable operation journal forces a full reconciliation
after an interrupted or ambiguous operation.

## Git integration and recovery

`.git` is never synchronized. Remote edits appear as ordinary local working
tree changes, so existing Git tools work normally.

Before overwriting or deleting a local file, the daemon snapshots the whole
working tree through a temporary Git index and writes a hidden reference under
`refs/antler/checkpoints/`. It does not modify HEAD, the current branch,
the real index, staged changes, or the working tree.

```sh
git for-each-ref --sort=-creatordate refs/antler/checkpoints/
git show <checkpoint-ref>:path/to/file
git restore --source <checkpoint-ref> -- path/to/file
```

The CLI wraps the last operation safely and creates another checkpoint first:

```sh
antler restore <checkpoint-ref> path/to/file
```

Existing `refs/moose-proxy/checkpoints/` references remain listable and
restorable; new checkpoints use only the Antler namespace.

If the sync root is not exactly a Git repository root, checkpoints are disabled
and the base/conflict object store remains available. Run `git init` before
`antler init` to enable checkpoint recovery for a new local directory.

## Transfer behavior

The steady-state path is fast because editing is entirely local. Watch events
contain only a path and change type, so the daemon stats that path and hashes
content only when its stored fingerprint changed. Directory scans and file
operations use bounded concurrency.

VS Code 1.85.2 does not expose a server-side content hash, delta/patch RPC, or a
verified writable non-truncating descriptor. An unchanged file transfers zero
bytes; a changed file is atomically replaced in full. The daemon never claims
rsync-style patching that the protocol cannot safely provide.

## Security defaults

- TLS certificate verification is enabled. `--insecure-skip-tls-verify` is an
  explicit development-only project setting.
- Absolute sync paths, `..`, NUL, backslash ambiguity, `.git`,
  `.antler`, and symlink components are denied.
- Both source and destination roots are checked independently.
- Only the VS Code management connection and `remoteFilesystem` operations are
  implemented; terminals, extensions, tunnels, and command execution are not.
- Logs redact password, cookie, token, authorization, and signed-handshake
  fields and never log file contents.

See [architecture and protocol evidence](docs/architecture.md),
[security](docs/security.md), [compatibility](docs/compatibility.md),
[validation](docs/validation.md), and [troubleshooting](docs/troubleshooting.md).

## Upstream reference checkout

```sh
scripts/fetch-upstream.sh
```

The script fetches code-server tag `v4.20.1` at commit
`e76afa4a2bf4667a3c9f71bf56ef34b8ad365fbe` and its pinned VS Code source at
`8b3775030ed1a69b13e4f4c628c612102e30a681`, verifies both identities, and
keeps the large checkout under ignored `reference/upstream/`.

## Integration test

The test creates and removes one uniquely named directory beneath the supplied
remote root:

```sh
ANTLER_INTEGRATION_CODE_SERVER_URL='https://code.legitimoose.com/INSTANCE/' \
ANTLER_INTEGRATION_CODE_SERVER_PASSWORD_FILE="$HOME/.config/antler/code-server-password" \
ANTLER_INTEGRATION_REMOTE_ROOT='/home/coder/project' \
  bun run test:integration:sync
```

It verifies watcher delivery, upload, download, conflict preservation and
resolution, nested directories, deletion approval, and cleanup.
