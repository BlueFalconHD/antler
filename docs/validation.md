# Validation record

Validated on 2026-07-11/12 (America/Chicago) with Node 25.9.0 for the bridge,
OpenSSH 10.2p1 for the client, and the official x86_64 macOS code-server 4.20.1
release under Rosetta on an arm64 Mac.

## Automated checks

```text
npm run typecheck  passed
npm run lint       passed
npm test           24 tests passed
npm run build      passed
npm audit          0 vulnerabilities
```

The unit suite covers framing split/coalescing, serialization tags and large
offsets, lexical traversal, separator ambiguity, symlink components, final-only
create gaps, error mapping, concurrent handle identity/cleanup, connection
generation invalidation, partial/offset staged writes, truncate, and abort.

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

## OpenSSH end to end

The stock `sftp` client successfully performed:

- REALPATH/PWD and root listing;
- mkdir `/alpha`;
- upload to `/alpha/upload.txt`;
- directory listing and download;
- rename to `/alpha/renamed.txt` and second download;
- file delete and directory delete.

Both downloads were byte-for-byte equal to the upload, and direct inspection
confirmed the remote root was empty after cleanup.

## Not run

The custom code-server 69.0.0 target was not tested because no reachable target
URL, password, or remote root was provided. This is the only external-access
blocker; the custom profile and fail-fast `/version` check are present.

The VS Code extension was not installed into a GUI session. The documented
Natizyskunk SFTP configuration omits plaintext credentials and uses only the
SFTP v3 operations covered by the OpenSSH and ssh2 integration runs.
