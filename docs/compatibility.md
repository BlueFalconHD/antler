# Compatibility matrix

| Target | Product commit used for path/handshake | Protocol source | Status |
| --- | --- | --- | --- |
| code-server 4.20.1 | `e76afa4a2bf4667a3c9f71bf56ef34b8ad365fbe` | VS Code 1.85.2 `8b3775030ed1a69b13e4f4c628c612102e30a681` | Verified locally, including path prefix and OpenSSH SFTP |
| Custom code-server 69.0.0 | expected `ebeb3c82ac91ac3e453356093435047ed911a179` | declared VS Code 1.85.2 | Profile implemented; live target unverified |

The expected custom WebSocket root is
`/stable-ebeb3c82ac91ac3e453356093435047ed911a179`, based on the public build
pipeline. A normal run probes authenticated `/version` and refuses to continue
if the deployment returns another product commit.

Custom compatibility must not be claimed until a reachable base URL, its
code-server password, and the intended remote root are available. No browser
GUI access is necessary.

## Protocol-sensitive differences

A target needs all of the following to match this profile:

- code-server password login and `code-server-session` cookie semantics;
- outer WebSocket authentication with internal connection tokens disabled;
- the pinned 13-byte persistent framing and IPC serializer;
- OSS identity sign fallback or an equivalent accepted handshake;
- management connection context compatible with VS Code 1.85.2;
- the listed `remoteFilesystem` command signatures and error names.

Use `--allow-version-mismatch` only while diagnosing a known development build;
it cannot make incompatible framing or RPC contracts safe.
