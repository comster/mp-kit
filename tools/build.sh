#!/bin/sh
# Copy only what the demo room needs at runtime into dist/ (no tests, no Worker, no node_modules).
set -e
cd "$(dirname "$0")/.."
rm -rf dist
mkdir -p dist
cp index.html dist/
cp -r demo kit dist/
echo "built dist/ ($(find dist -type f | wc -l | tr -d ' ') files)"
