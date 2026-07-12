# Compatibility matrix

| Target | Product commit used for path/handshake | Protocol source | Runtime status | Preserving remote write-open |
| --- | --- | --- | --- | --- |
| code-server 4.20.1 | `e76afa4a2bf4667a3c9f71bf56ef34b8ad365fbe` | VS Code 1.85.2 `8b3775030ed1a69b13e4f4c628c612102e30a681` | Verified, including path prefix and OpenSSH SFTP | Unsupported |
| Custom code-server 69.0.0 | `ebeb3c82ac91ac3e453356093435047ed911a179` | declares VS Code 1.85.2; public pinned source is the protocol authority | Verified live through a prefixed deployment with all required SFTP mutations | Unsupported by live probe |

The expected custom WebSocket root is
`/stable-ebeb3c82ac91ac3e453356093435047ed911a179`, based on the public build
pipeline. A normal run probes authenticated `/version` and refuses to continue
if the deployment returns another product commit.

The custom login page was inspected before connecting. It adds deployment
branding, a Minecraft-datapack usage notice, and a Cloudflare analytics script,
but retains the standard relative POST form, hidden `base` and `href` fields,
password field, prefix-scoped session cookie behavior, and authenticated
bootstrap values. Authenticated `/version` returned the exact custom product
commit. The bridge then completed the management handshake and every required
SFTP mutation against the folder from the connection URL.

This establishes runtime compatibility for the tested behavior; it does not
claim that unpublished custom source is byte-identical to public code-server.

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

The write-capability probe uses only disposable dotfiles under the configured
remote root. A custom profile must not set `writePreservingOpenOptions` until
that exact build has demonstrated a non-truncating writable descriptor. Extra
option keys are not sufficient: the verified custom target ignored them and
retained the stock read-only/truncating split.
