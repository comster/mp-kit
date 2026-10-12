#!/bin/sh
# Copy the kit into a game:  sh ../mp-kit/tools/sync-kit.sh <game-dir>
# Writes <game-dir>/src/kit/ and records which kit commit it came from in src/kit/VERSION. Also copies the
# test helpers a game's browser test needs into <game-dir>/tools/ (serve.mjs, hub-dev.mjs, hub-worker.js).
set -e
KIT="$(cd "$(dirname "$0")/.." && pwd)"
GAME="${1:?usage: sync-kit.sh <game-dir>}"
rm -rf "$GAME/src/kit"
mkdir -p "$GAME/src"
cp -r "$KIT/kit" "$GAME/src/kit"
# For the game's own browser test: a static server, and the Worker to run locally (the public room list).
mkdir -p "$GAME/tools"
cp "$KIT/tools/serve.mjs" "$KIT/tools/hub-dev.mjs" "$GAME/tools/"
cp "$KIT/worker/src/index.js" "$GAME/tools/hub-worker.js"
echo "mp-kit $(git -C "$KIT" rev-parse --short HEAD 2>/dev/null || echo unknown) $(date -u +%Y-%m-%d)" > "$GAME/src/kit/VERSION"
echo "copied kit to $GAME/src/kit ($(cat "$GAME/src/kit/VERSION"))"
