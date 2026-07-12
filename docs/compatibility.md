# Compatibility matrix

| Target | Product commit | Protocol authority | Live result |
| --- | --- | --- | --- |
| code-server 4.20.1 | `e76afa4a2bf4667a3c9f71bf56ef34b8ad365fbe` | VS Code 1.85.2 at `8b3775030ed1a69b13e4f4c628c612102e30a681` | Verified: auth, management WebSocket, watch event, both directions, conflict/resolve, nested upload, approved deletion |
| Custom code-server 69.0.0 | `ebeb3c82ac91ac3e453356093435047ed911a179` | Declares VS Code 1.85.2; the public pinned source remains authoritative | Verified live through its URL prefix with the same complete sync smoke suite |

The CLI authenticates `/version` and refuses an unexpected product commit by
default. The product commit—not the VS Code gitlink—is used in the
`/stable-<commit>` WebSocket route and second remote-agent handshake message.

The custom login page was inspected during the original compatibility work. It
adds branding and deployment-specific text but retains the password form,
hidden base/href values, prefix-scoped session cookie, and authenticated
bootstrap contract. Its unpublished source was not available, so compatibility
is claimed only for the exact live behavior tested.

## Required protocol surface

A compatible target must provide:

- code-server password login and `code-server-session` cookie semantics;
- prefix-correct authenticated WebSocket routing;
- the pinned 13-byte persistent protocol and IPC serialization;
- the OSS sign challenge and Management connection type;
- `remoteFilesystem` stat, readdir, readFile, writeFile, mkdir, delete, rename,
  watch, and unwatch contracts;
- `fileChange` IPC events with VS Code 1.85.2 payloads.

No verified profile provides a safe rsync-like patch operation or writable
non-truncating descriptor. Changed files therefore use full atomic replacement.

`--allow-version-mismatch` is for deliberate protocol investigation. It cannot
make incompatible framing, URI transformation, or event contracts safe.
