#!/bin/sh
# Rebuild kit/vendor/ from the pinned Trystero packages (MIT). Run after changing their version.
set -e
cd "$(dirname "$0")/.."
echo "export * from 'trystero'" > /tmp/mpkit-nostr.mjs
echo "export * from '@trystero-p2p/ws-relay'" > /tmp/mpkit-ws.mjs
cp /tmp/mpkit-nostr.mjs ./.vendor-nostr.mjs && cp /tmp/mpkit-ws.mjs ./.vendor-ws.mjs
npx esbuild .vendor-nostr.mjs --bundle --format=esm --minify --target=es2022 --outfile=kit/vendor/trystero-nostr.js
npx esbuild .vendor-ws.mjs --bundle --format=esm --minify --target=es2022 --outfile=kit/vendor/trystero-ws.js
rm -f .vendor-nostr.mjs .vendor-ws.mjs
cp node_modules/trystero/LICENSE kit/vendor/TRYSTERO-LICENSE
