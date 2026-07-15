
> [!NOTE]
> This project is untested on Windows and Linux. Exercise caution
> when using this, and report any bugs in the issues tab.
>
> Thanks <3

# Antler

Antler keeps a normal local datapack directory synchronized with its Legitimoose
workspace. Editors, Git, formatters, and build tools can operate on local files
as normal. Antler transfers the files that change to your Legitimoose pack.

## Install

```text
bun install
bun run check
bun run build:exe
# macOS/Linux
./dist/antler --version
# Windows PowerShell
.\dist\antler.exe --version
```

Cross-build executables with `bun run build:exe:linux`, `bun run build:exe:windows`,
`bun run build:exe:macos-arm64`, or `bun run build:exe:macos-x64`. Unix artifacts
are written to `dist/antler`; the Windows artifact is written to `dist/antler.exe`.

`dist/antler` and `dist/antler.exe` are [Bun standalone executables](https://bun.sh/docs/bundler/executables)
containing Antler, its dependencies, and the Bun runtime. Destination machines
need neither Bun nor Node.js.

`bun run build` also produces portable Node-compatible JavaScript at
`dist/index.js` for development.

## Releases

Pushing a tag that matches the package version, such as `v0.1.0`, runs the
GitHub Actions release workflow. It tests Antler, builds Linux x64, Windows x64,
macOS Apple Silicon, and macOS Intel executables, builds the `beet-antler` Python
package, publishes the artifacts and `SHA256SUMS` to a GitHub Release, and
generates release notes. PyPI publishing is enabled through the `PUBLISH_PYPI`
repository variable after trusted publishing is configured.

```sh
git tag v0.1.0
git push origin v0.1.0
```

## Connect a project

Create or choose a local directory, run `antler init`, and paste the complete URL
from your browser address bar when prompted. The normal GUI workspace URL and
the `/login?folder=...` URL are both accepted, including path-prefixed deployments.
Antler infers the remote project root from the `folder` query parameter.

```sh
antler init "$HOME/Projects/datapack"
# Paste: https://code.legitimoose.com/<your instance>/?folder=/home/coder/project/datapack
# Enter the code-server password at the hidden prompt.
```

Your instance password is not written to project files or persisted at all. Do
not place it directly in the command because command arguments may be recorded
in shell history or visible to other processes. If you need automated password
entry, use `ANTLER_CODE_SERVER_PASSWORD` or `--password-file`.

Initialization scans both file trees and syncs remote files. It is preferred to run initialization
in an empty directory to avoid initialization conflicts.

### Separate sync root

The project directory containing `.antler/` can be separate from the directory
that is synchronized. The sync root is stored relative to the project so the
configuration remains portable.

```sh
antler init "$HOME/Projects/datapack" --sync-root dist
```

This keeps state in `$HOME/Projects/datapack/.antler/` while synchronizing only
`$HOME/Projects/datapack/dist/`. The sync root must remain inside the project and
must not resolve through a symlink outside it. A project-level `dist/` Git ignore
does not prevent Antler from synchronizing its contents.

For noninteractive initialization, the full browser URL can also be supplied by
environment variable:

```sh
export ANTLER_CODE_SERVER_URL='https://code.legitimoose.com/<instance>/?folder=/home/coder/project/datapack'
export ANTLER_CODE_SERVER_PASSWORD='<password>'
antler init . --sync-root dist
```

## Beet integration

The first-party `beet-antler` plugin downloads the appropriate Antler release
binary into Beet's cache, verifies it against the release `SHA256SUMS`, and runs
Antler after Beet has finished writing its output.

```sh
uv add --dev beet-antler
```

```json
{
  "output": "dist",
  "pipeline": ["beet_antler"],
  "meta": {
    "antler": {
      "version": "latest",
      "sync": "auto",
      "approve_deletes": false
    }
  }
}
```

Set `ANTLER_CODE_SERVER_URL` and `ANTLER_CODE_SERVER_PASSWORD` as shown above.
On the first successful build the plugin initializes `.antler/` in the Beet
project root with `dist/` as its sync root. Later builds run a one-shot
`antler sync` after output. With `sync: "auto"`, missing credentials skip setup
and synchronization while still caching Antler; `sync: true` makes credentials
and synchronization mandatory, and `sync: false` only caches the executable.

Pin `version` to a release such as `0.1.4` for reproducible builds. The plugin
checks `latest` at most once every 24 hours and can reuse a previously verified
binary while offline. It never forces Antler's large-delete circuit breaker.
Avoid running `antler start` for the same project while Beet is building; Antler
will reject the concurrent operation rather than risk state corruption.

## Live synchronization

Antler subscribes to both local and remote events to synchronize changes both ways.

```sh
cd "~/projects/datapack"
antler start
```

While live synchronization is running, one-shot `antler sync` commands from
another terminal are sent to that live process. This includes deletion approval,
so the daemon can remain running while you review and approve pending deletions.

Alongside basic synchronization, Antler provides a myriad of tools to resolve conflicts,
restore backups, and more.

```sh
antler status
antler sync
antler conflicts
antler resolve README.md --take local
antler checkpoints
antler doctor
```

### Interactive shell

Use `antler sh` to enter a continuous Antler session for conflict resolution
or error resolution. The shell supports `status`, `sync`, `conflicts`, `resolve`, `checkpoints`,
`restore`, `doctor`, and `pwd`.

## `.antler/` state

Each project root contains a private `.antler/` directory that is excluded from
both synchronization directions and added to `.git/info/exclude` when the project
is inside a Git repository.

If this directory is lost or deleted, some information can be lost but no files
should be deleted remotely or locally.

## Conflicts and deletion safety

To ensure safe editing, Antler will track the hashes of local files. Local edits are
uploaded, remote edits are downloaded, and simultaneous but different edits are marked
as conflicting.

One-sided deletion propagation requires confirmation by default. `status` lists
pending deletions. After reviewing them, this command works whether or not
`antler start` is currently running:

```sh
antler sync --approve-deletes
```

To propagate one-sided deletions automatically, set the delete policy to `allow`:

```sh
antler config --delete-policy allow
```

Restart a running `antler start` process after changing the policy. New projects
can opt in during setup with `antler init --delete-policy allow`. The delete-count
and percentage circuit breaker still applies; override it for a reviewed batch
with `antler sync --approve-deletes --force-large-delete`.

## Git integration and recovery

Before overwriting or deleting a local file, the daemon snapshots the whole
working tree through a temporary Git index and writes a hidden reference under
`refs/antler/checkpoints/`. It does not modify HEAD, the current branch,
the real index, staged changes, or the working tree.

```sh
git for-each-ref --sort=-creatordate refs/antler/checkpoints/
git show <checkpoint-ref>:path/to/file
git restore --source <checkpoint-ref> -- path/to/file
```

The CLI wraps the last operation safely and creates another checkpoint first:

```sh
antler restore <checkpoint-ref> path/to/file
```

Checkpoints are available when the sync root is the Git repository root or a
directory beneath it. Ignored nested roots such as Beet's `dist/` are force-added
only to Antler's temporary checkpoint index; the real index and ignore rules are
unchanged. If the sync root is outside the repository, the base/conflict object
store remains available but Git checkpoints are disabled.
