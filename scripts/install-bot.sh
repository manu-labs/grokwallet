#!/bin/sh
# Install the pinned grokwallet CLI from a GitHub release and check SHA256SUMS.
# Usage: install-bot.sh [tag] [dest]
set -eu
TAG=${1:-v0.2.5}
DEST=${2:-"$HOME/.grokwallet/cli"}
REPO=${GROKWALLET_REPO:-manu-labs/grokwallet}
BASE="https://github.com/${REPO}/releases/download/${TAG}"
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT
cd "$WORKDIR"
curl -fsSL -o grokwallet-bot.tar.gz "${BASE}/grokwallet-bot.tar.gz"
curl -fsSL -o SHA256SUMS "${BASE}/SHA256SUMS"
if ! grep -q 'grokwallet-bot.tar.gz$' SHA256SUMS; then
  echo "SHA256SUMS has no grokwallet-bot.tar.gz line" >&2
  exit 1
fi
sha256sum -c SHA256SUMS --ignore-missing
rm -rf "$DEST"
mkdir -p "$DEST"
tar -xzf grokwallet-bot.tar.gz -C "$DEST" --strip-components=1
echo "installed ${TAG} to ${DEST}"
echo "next: cd ${DEST} && npm ci --omit=dev"
