# Antler

Antler keeps a normal local datapack directory synchronized with its Legitimoose
workspace. Editors, Git, formatters, and build tools can operate on local files
as normal. Antler transfers ones that chnage to your Legitimoose pack.

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

Cross-build x64 executables with `bun run build:exe:linux` or
`bun run build:exe:windows`. Artifacts are written to `dist/antler` and
`dist/antler.exe`, respectively.

`dist/antler` and `dist/antler.exe` are [Bun standalone executables](https://bun.sh/docs/bundler/executables)
containing Antler, its dependencies, and the Bun runtime. Destination machines
need neither Bun nor Node.js.

`bun run build` also produces portable Node-compatible JavaScript at
`dist/index.js` for development.

## Releases

Pushing a tag that matches the package version, such as `v0.3.0`, runs the
GitHub Actions release workflow. It tests Antler, builds Linux x64 and Windows
x64 executables, publishes compressed artifacts and `SHA256SUMS` to a
GitHub Release, and generates release notes.

```sh
git tag v0.3.0
git push origin v0.3.0
```

## Connect a project

Create or choose a local directory and paste the complete URL from the browser.
The CLI understands `/login?folder=...` URLs, including path-prefixed
deployments, and infers the remote project root.

```sh
antler init "$HOME/Projects/datapack" \
  --url 'https://code.legitimoose.com/<your instance>/login?folder=/home/coder/project/datapack&to='
```

Your instance password is not written to project files or persisted at all.
If you need automated password entry, use `ANTLER_CODE_SERVER_PASSWORD` or `--password-file`.

Initialization scans both file trees and syncs remote files. It is preferred to run initialization
in an empty directory to avoid initialization conflicts.

## Live synchronization

Antler subscribes to both local and remote events to synchronize changes both ways.

```sh
cd "~/projects/datapack"
antler start
```

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

Each local root contains a private `.antler/` directory that is excluded from both
synchronization directions, and is added to `.git/info/exclude` when the local root
is a Git repository.

If this directory is lost or deleted, some information can be lost but no files
should be deleted remotely or locally.

## Conflicts and deletion safety

To ensure safe editing, Antler will track the hashes of local files. Local edits are
uploaded, remote edits are downloaded, and simultaneous but different edits are marked
as conflicting.

Deletion propagation from a remote is disabled by default. `status` lists pending deletions.
After reviewing them:

```sh
antler sync --approve-deletes
```

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

If the sync root is not exactly a Git repository root, checkpoints are disabled
and the base/conflict object store remains available. Run `git init` before
`antler init` to enable checkpoint recovery for a new local directory.
