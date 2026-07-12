# Validation record

Validated on 2026-07-11/12 (America/Chicago) with Node 25.9.0 for the bridge,
OpenSSH 10.2p1 for the client, and the official x86_64 macOS code-server 4.20.1
release under Rosetta on an arm64 Mac.

## Automated checks

```text
npm run typecheck  passed
npm run lint       passed
npm test           35 tests passed
npm run build      passed
npm audit          0 vulnerabilities
```

The unit suite covers framing split/coalescing, serialization tags and large
offsets, lexical traversal, separator ambiguity, symlink components, final-only
create gaps, error mapping, concurrent handle identity/cleanup, connection
generation invalidation, partial/offset staged writes, truncate, and abort. It
also covers changed-range merging, atomic copy-and-patch selection for a
capability-enabled profile, and zero-transfer close for an unchanged preserved
handle. Local-authentication tests cover agent order, remembered identity,
sorted public-key-file fallback, explicit overrides, missing-key instructions,
and valid/invalid SSH signatures.

`npm run test:integration:key-auth` also passed a real loopback SSH handshake
using a generated Ed25519 client key and confirmed that the successful
fingerprint was remembered. The same handshake opens an SFTP subsystem and
verifies ForkLift's empty initial `REALPATH` resolves to virtual `/`. Automatic
discovery on the validation machine selected its existing
`~/.ssh/id_ed25519.pub` identity without reading the private key.

## Public code-server integration

Runtime identity:

```text
code-server 4.20.1 e76afa4a2bf4667a3c9f71bf56ef34b8ad365fbe
Code 1.85.2
```

The bridge successfully completed authentication, `/version`, the
`/stable-e76afa4...` WebSocket upgrade, handshake, IPC initialization, and
`remoteFilesystem` channel setup.

The same sequence and SFTP smoke suite passed through a reverse proxy at a
public URL ending in `/prefix/`, validating prefix-scoped login cookies and
WebSocket routing.

`npm run test:integration:sftp` passed remote create, staged read-after-write,
non-truncating offset write, close/commit, download, FSETSTAT truncate, rename,
delete, and rmdir.

A live symlink inside the remote root pointing to an outside file was visible
as a link in the listing, but STAT/open/download was rejected with SFTP
PERMISSION_DENIED and no local output file was created.

## Custom code-server 69.0.0 integration

The provided prefixed deployment was inspected and tested live. Its branded
login page retained the public login contract. Authenticated `/version`
returned:

```text
ebeb3c82ac91ac3e453356093435047ed911a179
```

The bridge completed the custom stable-route WebSocket upgrade, Management
handshake, IPC initialization, and `remoteFilesystem` setup for
`/home/coder/project/datapack`. The disposable SFTP suite passed create,
upload, unchanged `r+` close, staged read-after-write, offset write, truncate,
download verification, rename, delete, and rmdir. Debug diagnostics confirmed
that the unchanged handle transferred zero bytes and that a two-byte edit was
identified as a two-byte changed range.

The preserving-write probe tried `create:false` with `write`, `writable`, and
`truncate:false`; all writes failed with `EBADF` while leaving the original ten
bytes intact. Both tested `create:true` variants truncated to zero at open.
This proves that partial remote patching cannot be activated safely for this
build. Changed files use the atomic full-replacement fallback.

## OpenSSH end to end

The stock `sftp` client successfully performed:

- REALPATH/PWD and root listing;
- mkdir `/alpha`;
- upload to `/alpha/upload.txt`;
- directory listing and download;
- rename to `/alpha/renamed.txt` and second download;
- file delete and directory delete.

The sequence passed against both the public baseline and the custom target.
All downloads were byte-for-byte equal to the uploads, and disposable remote
files/directories were removed after each run.

## Not run

The VS Code extension was not installed into a GUI session. The documented
Natizyskunk SFTP configuration omits plaintext credentials and uses only the
SFTP v3 operations covered by the OpenSSH and ssh2 integration runs.

The custom server's unpublished source was not available, so compatibility is
claimed from exact runtime identity, captured framing, and live behavior—not
from a custom-source audit. The public v4.20.1 tag and its pinned VS Code commit
remain authoritative for every protocol implementation decision.
