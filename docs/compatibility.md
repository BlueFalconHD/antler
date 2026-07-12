# Supported Legitimoose target

Antler has one protocol target and no selectable compatibility profiles:

| Service | Server version | Product commit | VS Code protocol base | Live result |
| --- | --- | --- | --- | --- |
| Legitimoose code server | `69.0.0` | `ebeb3c82ac91ac3e453356093435047ed911a179` | VS Code 1.85.2 at `8b3775030ed1a69b13e4f4c628c612102e30a681` | Verified through the deployment prefix: authentication, Management WebSocket, watch events, both sync directions, conflict resolution, nested upload, rename, and approved deletion |

The identity lives in `src/compatibility/legitimoose.ts`. Updating the service
requires changing that constant and repeating the integration suite. The CLI
authenticates `/version` and refuses any other product commit by default. The
product commit—not the VS Code gitlink—is also used in the
`/stable-<commit>` WebSocket route and remote-agent handshake.

`--allow-version-mismatch` exists only for deliberate protocol investigation.
It does not select another implementation or make incompatible framing, URI
transformation, or event contracts safe.

## Public source authority

The public code-server v4.20.1 source at
`e76afa4a2bf4667a3c9f71bf56ef34b8ad365fbe` and its pinned VS Code commit
`8b3775030ed1a69b13e4f4c628c612102e30a681` remain the auditable authority for
login, routing, framing, negotiation, IPC serialization, and
`remoteFilesystem`. Public code-server is a protocol reference and test
fixture, not a supported Antler runtime target.

The Legitimoose login page retains the password form, hidden base/href values,
prefix-scoped session cookie, and authenticated bootstrap contract established
by that public source. Its unpublished changes are covered only by live tests
against the exact product commit above.

## Required protocol surface

The supported target provides:

- code-server password login and `code-server-session` cookie semantics;
- prefix-correct authenticated WebSocket routing;
- the pinned 13-byte persistent protocol and IPC serialization;
- the OSS sign challenge and Management connection type;
- `remoteFilesystem` stat, readdir, readFile, writeFile, mkdir, delete, rename,
  watch, and unwatch contracts;
- `fileChange` IPC events with VS Code 1.85.2 payloads.

Legitimoose exposes no verified server-side delta patch, remote hash, or safe
writable non-truncating descriptor. Changed files therefore use full atomic
replacement; unchanged files transfer zero bytes.
