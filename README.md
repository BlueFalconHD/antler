# moose-proxy

`moose-proxy` keeps a normal local working directory synchronized with a
code-server project. Editors, Git, formatters, and build tools use local files;
the foreground daemon transfers only changed files through code-server's
authenticated VS Code `remoteFilesystem` channel.

There is no local SSH/SFTP server, port, host key, or editor extension to
configure.

## Install

Node.js 20.18.1 or newer is required.

```sh
npm ci
npm run check
npm link
```

`npm link` makes the `moose-proxy` command available locally. It is optional;
`node /path/to/moose_proxy/dist/index.js` runs the same CLI.

## Connect a project

Create or choose a local directory and paste the complete URL from the browser.
The CLI understands `/login?folder=...` URLs, including path-prefixed
deployments, and infers the remote project root.

```sh
moose-proxy init "$HOME/Projects/datapack" \
  --url 'https://code.example.test/deployment/login?folder=/home/coder/project/datapack&to='
```

The password is requested without echo. It is never accepted as a command-line
value or written to project state. For unattended starts, use
`MOOSE_PROXY_CODE_SERVER_PASSWORD` or a protected file:

```sh
umask 077
mkdir -p "$HOME/.config/moose-proxy"
read -r -s -p 'code-server password: ' CODE_SERVER_PASSWORD; printf '\n'
printf '%s\n' "$CODE_SERVER_PASSWORD" > "$HOME/.config/moose-proxy/code-server-password"
unset CODE_SERVER_PASSWORD

moose-proxy init "$HOME/Projects/datapack" \
  --url 'https://code.example.test/deployment/login?folder=/home/coder/project/datapack&to=' \
  --password-file "$HOME/.config/moose-proxy/code-server-password"
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
moose-proxy start
```

Running `moose-proxy` with no command also starts the nearest project. The
daemon subscribes to local and remote events, coalesces editor save bursts,
reconciles only affected paths, and performs a full scan after startup,
reconnection, watcher errors, and every 30 seconds as a correctness backstop.

Typical output is intentionally compact:

```text
✓ Connected to code-server 69.0.0  profile=custom-v69
✓ Remote root confined  remoteRoot=/home/coder/project/datapack
✓ Live synchronization is running
✓ ↑ Uploaded data/example.json  bytes=4312  durationMs=82.1
✓ ↓ Downloaded pack.mcmeta  bytes=187  durationMs=31.4
⚠ Conflict: README.md — neither copy was changed
```

Useful commands:

```sh
moose-proxy status
moose-proxy sync
moose-proxy conflicts
moose-proxy resolve README.md --take local
moose-proxy checkpoints
moose-proxy doctor
```

Use `--format json` for machine-readable diagnostics, `--format plain` for
stable uncolored lines, and `--log-level debug` for additional protocol-safe
diagnostics.

## `.moose_proxy/` state

Each local root contains a private `.moose_proxy/` directory:

```text
.moose_proxy/
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

If this directory is lost, the daemon refuses to start. Re-initialization does
not invent a winner: common files are compared again and differences become
conflicts.

## Conflicts and deletion safety

The last synchronized content hash is the common base. A local-only edit is
uploaded, a remote-only edit is downloaded, identical simultaneous edits are
re-baselined, and different simultaneous edits are preserved as a conflict.

Deletion propagation is disabled by default. `status` lists pending deletions.
After reviewing them:

```sh
moose-proxy sync --approve-deletes
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
`refs/moose-proxy/checkpoints/`. It does not modify HEAD, the current branch,
the real index, staged changes, or the working tree.

```sh
git for-each-ref --sort=-creatordate refs/moose-proxy/checkpoints/
git show <checkpoint-ref>:path/to/file
git restore --source <checkpoint-ref> -- path/to/file
```

The CLI wraps the last operation safely and creates another checkpoint first:

```sh
moose-proxy restore <checkpoint-ref> path/to/file
```

If the sync root is not exactly a Git repository root, checkpoints are disabled
and the base/conflict object store remains available. Run `git init` before
`moose-proxy init` to enable checkpoint recovery for a new local directory.

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
  `.moose_proxy`, and symlink components are denied.
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
MOOSE_PROXY_INTEGRATION_CODE_SERVER_URL='https://code.example.test/deployment/' \
MOOSE_PROXY_INTEGRATION_CODE_SERVER_PASSWORD_FILE="$HOME/.config/moose-proxy/code-server-password" \
MOOSE_PROXY_INTEGRATION_REMOTE_ROOT='/home/coder/project' \
MOOSE_PROXY_INTEGRATION_PROFILE='custom-v69' \
  npm run test:integration:sync
```

It verifies watcher delivery, upload, download, conflict preservation and
resolution, nested directories, deletion approval, and cleanup.
