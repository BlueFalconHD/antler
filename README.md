# moose-proxy

`moose-proxy` exposes one directory from a code-server host as a local SFTP
server. Ordinary SFTP clients talk to localhost; the bridge authenticates to
code-server, opens its internal VS Code management WebSocket, and issues only
`remoteFilesystem` channel calls.

The public baseline is code-server 4.20.1 at
`e76afa4a2bf4667a3c9f71bf56ef34b8ad365fbe`, with VS Code 1.85.2 source at
`8b3775030ed1a69b13e4f4c628c612102e30a681`.

## Supported operations

- REALPATH, STAT, and LSTAT for non-symlink paths
- directory open, paged listing, and close
- concurrent file handles and offset reads
- create, upload, offset write, append, truncate, and close
- merged changed-range tracking, unchanged-handle elision, and atomic partial
  patching when a compatibility profile exposes non-truncating write-open
- mkdir, remove, rmdir, and non-overwriting rename
- deterministic SFTP v3 status mapping and explicit unsupported responses
- future-operation reconnect after transport loss; existing handles are invalidated

FTP, filesystem watching, symlink traversal, readlink, symlink creation, chmod,
chown, and timestamp mutation are intentionally unsupported.

## Install and build

Node.js 20.18.1 or newer is required.

```sh
npm ci
npm run check
```

The production entry point is `dist/index.js`; `npm run build` creates it.

## Store secrets safely

Password values are never accepted as command-line flags. A protected file is
recommended. The CLI also accepts `MOOSE_PROXY_CODE_SERVER_PASSWORD` and
`MOOSE_PROXY_SFTP_PASSWORD`, or prompts without echo when attached to a TTY.

```sh
umask 077
mkdir -p "$HOME/.config/moose-proxy"
read -r -s -p 'code-server password: ' CODE_SERVER_PASSWORD; printf '\n'
printf '%s\n' "$CODE_SERVER_PASSWORD" > "$HOME/.config/moose-proxy/code-server-password"
unset CODE_SERVER_PASSWORD
read -r -s -p 'local SFTP password: ' SFTP_PASSWORD; printf '\n'
printf '%s\n' "$SFTP_PASSWORD" > "$HOME/.config/moose-proxy/sftp-password"
unset SFTP_PASSWORD
```

Secret files must be regular, non-symlink files with no group/other permission
bits. The code-server password and session cookie remain in memory and are
never persisted by the bridge.

## Run

```sh
node dist/index.js \
  --code-server-url https://code.example.test/code/ \
  --code-server-password-file "$HOME/.config/moose-proxy/code-server-password" \
  --remote-root /home/me/project \
  --sftp-password-file "$HOME/.config/moose-proxy/sftp-password"
```

The SFTP endpoint defaults to `127.0.0.1:2222`, username `moose`. A persistent
Ed25519 host key is generated at
`~/.config/moose-proxy/ssh_host_ed25519_key`; use `--ssh-host-key` to choose a
different path.

Connect with OpenSSH and enter the local SFTP password when prompted:

```sh
sftp -P 2222 moose@127.0.0.1
```

The configured remote root appears as `/`. The URL may include a reverse-proxy
path prefix; retain the trailing root path in `--code-server-url` as shown.

Select the custom target with `--profile custom-v69`. The live 69.0.0 target at
product commit `ebeb3c82ac91ac3e453356093435047ed911a179` has been verified with
the required SFTP operations. If the supplied browser URL ends in
`/login?folder=...`, pass only its deployment root through the slash before
`login`; `--remote-root` receives the decoded `folder` path separately.

## Partial edits

SFTP offset writes are always accepted without requiring the client to upload
the whole file. The bridge merges the changed byte ranges. A profile with a
verified non-truncating remote write-open uses a server-side copy, sends only
those ranges, then atomically renames the copy. Opening an existing file for
write and closing it unchanged sends no file data.

VS Code 1.85.2's stock `remoteFilesystem` provider—and the verified custom
69.0.0 target—cannot open an existing file writable without truncating it. On
those profiles, an actual content change therefore falls back to a streamed
full temporary replacement. This is a protocol limitation, not a client-side
choice; the bridge never risks an in-place partial overwrite or reports a
partial commit that did not occur.

## Safety-related options

- TLS certificate verification is on by default. The explicit
  `--insecure-skip-tls-verify` flag is development-only and emits a warning.
- Any listen address other than loopback requires `--allow-non-loopback`.
- `--omit-origin` is available for reverse proxies whose origin handling
  differs from code-server's browser flow.
- `--allow-version-mismatch` is protocol-development escape hatch; normal runs
  fail fast when code-server `/version` differs from the selected profile.
- Staged writes use a private local directory and 0600 files. Point
  `--staging-directory` at an encrypted volume if local-at-rest confidentiality
  is required.

See [architecture and protocol evidence](docs/architecture.md),
[security](docs/security.md), [compatibility](docs/compatibility.md), and
[troubleshooting](docs/troubleshooting.md).

## VS Code SFTP extension

An example for [Natizyskunk's SFTP extension](https://github.com/Natizyskunk/vscode-sftp) is in
[`examples/vscode-sftp.json`](examples/vscode-sftp.json). Copy it to
`.vscode/sftp.json`. The password is deliberately omitted so the extension
prompts instead of storing it in plaintext. Keep `useTempFile` and `openSsh`
disabled because the bridge already commits staged uploads with a remote
temporary file and rename.

## Upstream reference checkout

```sh
scripts/fetch-upstream.sh
```

The script fetches exact commits into ignored `reference/upstream/`, verifies
both SHAs, and avoids committing the large upstream trees.

## Validation

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

With a bridge running, the offset-write/truncate smoke test is:

```sh
MOOSE_PROXY_INTEGRATION_PASSWORD_FILE="$HOME/.config/moose-proxy/sftp-password" \
  MOOSE_PROXY_INTEGRATION_PORT=2222 npm run test:integration:sftp
```

Protocol development can test a disposable file for a custom preserving-write
extension. This command prints the result for each candidate and always removes
its probe files:

```sh
MOOSE_PROXY_INTEGRATION_CODE_SERVER_URL=https://code.example.test/prefix/ \
MOOSE_PROXY_INTEGRATION_CODE_SERVER_PASSWORD_FILE="$HOME/.config/moose-proxy/code-server-password" \
MOOSE_PROXY_INTEGRATION_REMOTE_ROOT=/home/me/project \
  npm run test:integration:write-probe
```

The exact public-baseline and OpenSSH validation performed for this repository
is recorded in [docs/validation.md](docs/validation.md).
