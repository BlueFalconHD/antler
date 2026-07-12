#!/bin/sh
set -eu

CODE_SERVER_TAG=v4.20.1
CODE_SERVER_COMMIT=e76afa4a2bf4667a3c9f71bf56ef34b8ad365fbe
VSCODE_COMMIT=8b3775030ed1a69b13e4f4c628c612102e30a681
DESTINATION=${1:-reference/upstream/code-server-v4.20.1}

if [ ! -d "$DESTINATION/.git" ]; then
  mkdir -p "$(dirname "$DESTINATION")"
  git clone --filter=blob:none --no-checkout https://github.com/coder/code-server.git "$DESTINATION"
fi

git -C "$DESTINATION" fetch --depth 1 origin "refs/tags/$CODE_SERVER_TAG:refs/tags/$CODE_SERVER_TAG"
git -C "$DESTINATION" checkout --detach "$CODE_SERVER_COMMIT"
git -C "$DESTINATION" submodule sync -- lib/vscode
git -C "$DESTINATION" submodule update --init --depth 1 lib/vscode

actual_code_server=$(git -C "$DESTINATION" rev-parse HEAD)
actual_vscode=$(git -C "$DESTINATION/lib/vscode" rev-parse HEAD)

if [ "$actual_code_server" != "$CODE_SERVER_COMMIT" ]; then
  echo "unexpected code-server commit: $actual_code_server" >&2
  exit 1
fi
if [ "$actual_vscode" != "$VSCODE_COMMIT" ]; then
  echo "unexpected VS Code commit: $actual_vscode" >&2
  exit 1
fi

echo "code-server $CODE_SERVER_TAG: $actual_code_server"
echo "VS Code pinned source: $actual_vscode"
