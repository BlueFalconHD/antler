# Troubleshooting

## No project is found

Run `moose-proxy init <local-directory>` first. Commands search upward from the
given directory for `.moose_proxy/config.json`, like Git searches for `.git`.
Missing or malformed state never causes either tree to become authoritative.

## Authentication fails

- Paste the public browser URL, including its reverse-proxy prefix. A full
  `/login?folder=...` URL is accepted by `init`.
- Wrong passwords return the login HTML with HTTP 200; the CLI recognizes this
  as failure. Avoid rapid retries because code-server rate-limits login errors.
- A password file must be a non-symlink regular file with mode 0600 or stricter.
- External SSO without code-server's password form is outside these profiles.

If an ephemeral instance changes its password, update the protected password
file or omit `--password-file` and enter the new value when starting.

## `/version` or handshake mismatch

Public v4.20.1 must return `e76afa4a...`; the VS Code gitlink
`8b377503...` is not the product commit. Run `moose-proxy doctor` and select the
matching profile. Use `--allow-version-mismatch` only while investigating a
known development build.

`Unauthorized client` usually means the target re-enabled a proprietary
connection token or signing scheme not present in public code-server.

## WebSocket 404/403

- Preserve the deployment prefix from the browser URL.
- The proxy must forward WebSocket upgrades and query parameters on
  `<prefix>/stable-<productCommit>`.
- `skipWebSocketFrames=false` is required.
- Fix Host/Origin rewriting in the proxy first. `--omit-origin` exists only for
  a known deployment that deliberately accepts missing Origin.

## TLS errors

Install the issuing CA or use a certificate matching the URL. The
`--insecure-skip-tls-verify` init option is development-only and persists in
project config so the insecure state remains visible.

## A path is rejected

Symlinks are deliberately unsupported. On macOS, `/tmp` is a symlink to
`/private/tmp`; configure the canonical path. Absolute event paths outside the
root, backslashes, NUL, `..`, `.git`, and `.moose_proxy` are also denied.

## A file becomes a conflict

Nothing has been overwritten. Inspect both local and remote versions, then:

```sh
moose-proxy resolve path/to/file --take local
# or
moose-proxy resolve path/to/file --take remote
```

Resolution is refused if either fingerprint changed after conflict detection.
The discarded bytes are saved beneath `.moose_proxy/conflicts/` before the
chosen version is written.

Type conflicts and delete/modify conflicts require manually making both sides
the same kind before resolving.

## A deleted file remains on the other side

This is the safe default. Review `moose-proxy status`, then run:

```sh
moose-proxy sync --approve-deletes
```

If the circuit breaker activates, verify the proposed scale before adding
`--force-large-delete`. A branch checkout can legitimately produce a large
batch, but an incorrect root can look identical; do not bypass the warning
without checking.

## Remote updates are delayed

Run `moose-proxy doctor` to verify that event subscription setup succeeds.
Native VS Code watchers start asynchronously behind the watch RPC, so the
daemon always installs the watcher before its startup reconciliation. Events
remain hints: a 30-second full reconciliation recovers from a missed/coalesced
event. Watcher errors and reconnects trigger an immediate full scan.

## Repeated `Reserved sync path component` watcher warnings

`.git` and `.moose_proxy` activity is expected and should be silent. Older
builds validated an absolute macOS watcher filename before recognizing the
reserved component, causing a rapid warning/restart loop. Rebuild and restart
the process so `dist/` contains the raw-path filter:

```sh
cd /path/to/moose_proxy
npm run build
node dist/index.js start /path/to/local/project
```

Stop the old process with Ctrl-C before launching the rebuilt one. A long-lived
old loop can temporarily exhaust watcher descriptors (`EMFILE`); stopping all
old moose-proxy processes releases them before the new daemon starts.

The current watcher drops both absolute and relative reserved paths before
normalization. If the warning remains after a clean restart, run with
`--log-level debug` and report the first warning plus `node --version`; do not
delete `.moose_proxy`.

## Repeated commands keep asking for the password

Top-level commands are independent processes and intentionally authenticate
independently. For an interactive session, run `moose-proxy sh` once and use
`status`, `sync`, `conflicts`, `resolve`, `checkpoints`, `restore`, and `doctor`
at its prompt. The cookie and WebSocket remain in memory until the shell exits.
Use `moose-proxy start` separately when continuous watch synchronization is
desired.

## Reconnect loop

Local edits remain queued. The daemon reconnects with bounded exponential
backoff, creates a new watcher session, and performs a full reconciliation
before trusting subsequent events. Check the code-server lifetime, password,
TLS certificate, prefix route, and `/version` value.

## Interrupted operation is reported

The journal means an operation lost a definitive completion point. Run
`moose-proxy sync`; it performs a full comparison and converges based on actual
content. Do not delete `state.json` to clear the warning.

## Transfer is still large

The daemon avoids all transfer when a file's content is unchanged and only
examines paths that changed during steady state. VS Code 1.85.2 has no remote
hash or delta-patch RPC, so a genuinely changed file is atomically uploaded or
downloaded in full. This is a protocol limitation, not a disabled option.

Large initial trees require one remote stat per entry because readdir returns
names and types, not full metadata. Bounded concurrency prevents this from
serializing every round trip.
