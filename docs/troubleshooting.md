# Troubleshooting

## Authentication fails

- Verify that `--code-server-url` is the public root users open in a browser,
  including any reverse-proxy prefix.
- A wrong password returns a rendered HTTP 200 login page. The bridge recognizes
  this and reports login failure; avoid repeated attempts because code-server
  rate-limits failures.
- Confirm the password file is mode 0600 and is not a symlink.
- A deployment using external SSO instead of code-server's password form is not
  supported by this profile.

## ForkLift or local SFTP authentication fails

- Check the startup `local SFTP authentication configured` record. In ForkLift,
  choose SFTP, `127.0.0.1`, port `2222`, username `moose`, then click the key
  icon in the Password field and select the logged `privateKeyHint` path.
- The remembered identity is the last key that authenticated successfully to
  this bridge; OpenSSH does not provide a trustworthy system-wide last-used-key
  timestamp. If it is unavailable, the first `ssh-add -L` identity or first
  sorted `~/.ssh/*.pub` file is selected.
- Run `ssh-add -L` to confirm the agent exposes public identities. If no key is
  available, run `ssh-keygen -t ed25519`, then
  `ssh-add ~/.ssh/id_ed25519`.
- Use `--sftp-authorized-key <public-key-path>` to override discovery. Use
  `--sftp-password-file` or `MOOSE_PROXY_SFTP_PASSWORD` only when password
  authentication is specifically desired.
- ForkLift may initialize a favorite with an empty `REALPATH` when its Path
  field is blank. Current builds accept that as virtual `/`; older builds log
  `Malformed path`. Set Path to `/` or update and restart the bridge.

## `/version` mismatch

The response is the product commit used in both the WebSocket path and second
handshake message. Public 4.20.1 must return `e76afa4a...`, not its VS Code
gitlink `8b377503...`. Select the matching profile. Use
`--allow-version-mismatch` only for protocol investigation.

## WebSocket routing or HTTP 404/403

- Preserve the public path prefix in `--code-server-url`.
- The proxy must forward WebSocket upgrades on
  `<prefix>/stable-<productCommit>` and retain query parameters.
- The bridge sends `skipWebSocketFrames=false`; changing it to true is
  incompatible with the WebSocket transport.
- If a proxy rewrites Host/Origin unexpectedly, first fix the proxy. For a
  known non-browser-compatible proxy, `--omit-origin` uses code-server's
  explicitly supported no-Origin path.

## TLS errors

Install the issuing CA in the host trust store or use a certificate whose name
matches the URL. `--insecure-skip-tls-verify` exists only for isolated
development and should not be used for production credentials.

## Handshake rejection

- `version mismatch` means `/version`, the `stable-<commit>` route, and profile
  commit do not agree.
- `Unauthorized client` suggests the deployment re-enabled a VS Code connection
  token or proprietary signing. This is outside the public profile.
- Enable `--log-level debug`; logs contain stages and status but redact tokens,
  cookies, passwords, authorization data, and contents.

## Permission denied on a path

The confinement policy rejects any symlink component, including `/tmp` on
macOS (which points to `/private/tmp`). Configure the canonical non-symlink
remote path, such as `/private/tmp/...`, or a normal project directory.

## Upload or truncate fails

- The local staging directory must be a private, non-symlink directory.
- Ensure the local disk has enough space for the entire largest write-opened
  file.
- After an unclean process or machine crash, remove abandoned 0600 files from
  the configured local staging directory and `.moose-proxy-*.tmp` files from
  affected remote destination directories.
- A connection loss invalidates an existing handle intentionally. Reopen it;
  uncertain mutations are not replayed.
- Concurrent bridge write handles to one path are serialized. An independent
  remote process can still change the file and cause the close-time type/race
  checks to fail.

## Partial edit performs a full remote replacement

Run `npm run test:integration:write-probe` with the three documented
integration environment variables. `EBADF` for `create:false` and a size of
zero after `create:true` means the provider has the stock VS Code 1.85.2
limitation: it exposes no writable, non-truncating descriptor. The bridge still
accepts offset SFTP writes, but safely commits the changed file through a full
temporary replacement. Do not force-enable the profile capability; a false
declaration either fails closed or could corrupt a temporary patch copy.

## SFTP client reports unsupported

The bridge supports conventional create mode 0644/0666 and directory mode
0755/0777, which match the remote provider's default creation semantics.
Arbitrary mode, owner, group, access time, modification time, link operations,
and vendor extensions return OP_UNSUPPORTED.
