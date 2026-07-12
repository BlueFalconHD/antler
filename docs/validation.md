# Validation record

Validated on 2026-07-12 (America/Chicago) with Bun 1.3.1 and Node 25.9.0.

## Automated checks

```text
bun install --frozen-lockfile  passed
bun run typecheck              passed
bun run lint                   passed
bun run test                   passed (92 tests)
bun run build                  passed
bun run build:exe              passed (native arm64 Mach-O)
bun audit                      passed (0 vulnerabilities)
```

The unit suite covers:

- split/coalesced persistent framing and IPC value serialization;
- exact IPC EventListen/EventFire/EventDispose headers, shared ids, callback
  isolation, and connection-loss cleanup;
- watcher listener-before-watch ordering, payload validation, and idempotent
  unwatch/disposal;
- absolute and relative macOS watcher-name filtering for `.git`,
  `.antler`, legacy state, and both transfer-temporary namespaces;
- atomic `.moose_proxy` to `.antler` adoption, schema migration without a
  runtime target selector, and ambiguous dual-state refusal;
- interactive-shell quoting, command validation, unsupported-command failure,
  and repeated dispatch through one supplied authenticated runtime;
- traversal, absolute paths, separator ambiguity, hard state/Git exclusions,
  and remote watcher root confinement;
- local atomic writes, state permissions, malformed/missing state failure, and
  symlink rejection;
- initial one-sided copies, identical baselines, mismatched-file conflicts,
  both edit directions, simultaneous conflicts, deletion approval, journal
  recovery, targeted nested-parent creation, unique renames in both directions,
  and checkpoint coalescing;
- real Git hidden-ref snapshots containing tracked/untracked changes without
  changing HEAD, the current index, status, or working tree;
- connection generation invalidation and reconnect-on-next-use.

## Public source fixture evidence

Runtime identity:

```text
code-server 4.20.1 e76afa4a2bf4667a3c9f71bf56ef34b8ad365fbe
VS Code 1.85.2 8b3775030ed1a69b13e4f4c628c612102e30a681
```

Before runtime target selection was removed, the official architecture-neutral
v4.20.1 release package was run with VS
Code's pinned native Node 18.17.1 arm64 runtime. The full disposable sync smoke
test passed:

- password authentication and `/version`;
- stable-route WebSocket, sign challenge, Management connection, IPC init;
- remote watcher subscription and observed file-change event;
- local upload and remote download;
- simultaneous-change conflict with both originals unchanged;
- explicit local conflict resolution;
- nested directory/file upload and hash-confirmed remote rename;
- held deletion followed by explicit approved deletion;
- recursive cleanup of the unique remote test directory.

The native watcher starts asynchronously after the `watch` RPC. A test that
wrote immediately after the RPC could miss its event. The production ordering
(subscribe, then full reconcile, then accept live events) passed and is covered
by the integration test.

The built CLI was also exercised separately: a pasted
`/login?folder=...&to=` URL initialized a project, `sync` uploaded a file,
`status` reported its baseline, and a foreground `start` daemon observed both a
local edit and an external remote edit. Idle state produced no self-triggered
`.antler` event loop, and SIGINT shut down both watchers cleanly.

This remains protocol-source and regression evidence; current Antler releases
intentionally accept only the Legitimoose product commit.

## Legitimoose 69.0.0

Authenticated `/version` returned:

```text
ebeb3c82ac91ac3e453356093435047ed911a179
```

The disposable sync smoke suite passed through the supplied deployment
prefix against `/home/coder/project/datapack`. This directly verifies the
Legitimoose authentication flow, prefix routing, Management handshake, remote
watcher event, upload/download, conflict preservation/resolution, nested
creation, rename, approved deletion, and cleanup.

The standalone Bun `dist/antler` executable was opened against a disposable
copy of the retained local pairing. It first migrated `.moose_proxy` to
profile-free `.antler` state without changing the real project. One
authentication then established the Legitimoose Management connection;
`status` reported 17 matching tracked entries, `doctor` created/disposed a
remote watch and read both 17-entry trees, and `exit` closed the shared session
with status 0. This shell smoke was read-only.

A post-rebrand rerun of the disposable remote mutation suite was requested but
the host execution gate rejected write/rename/delete access beneath the real
workspace root. The exact command remains the documented
`bun run test:integration:sync` invocation in the README; it creates only a
UUID-named child, exercises the operations, and removes that child. The full
suite result above predates the naming/runtime-packaging change, while the
current standalone executable has the read-only live coverage described here.

No password or session cookie was written into the repository or sync state.
The test password lived only in a protected temporary input file and was not
logged.

## Public fixture note

The official v4.20.1 macOS release provides only x86_64. Its watcher was first
tested under Rosetta and behaved the same as the native fixture: an event
written immediately after `watch` can be missed during watcher startup. This
was not treated as a protocol failure because the documented production
ordering passed on the native fixture and Legitimoose.

## Remaining platform scope

The live tests ran on macOS for the local side and on the public local fixture
plus Legitimoose. Windows local path behavior is implemented through portable
path APIs and drive-letter rejection but has not had a live Windows run.
The Legitimoose implementation's unpublished source was unavailable;
compatibility is established from exact runtime identity, captured framing,
and observed behavior, while the public pinned source remains authoritative.
