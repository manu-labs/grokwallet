#!/bin/sh
# Pin a directory to IPFS with a Pinata JWT. Prints the CID.
# Requires IPFS_PINNING_TOKEN. Does not echo the token.
set -eu
ROOT=${1:?usage: pin-ipfs.sh <directory>}
if [ -z "${IPFS_PINNING_TOKEN:-}" ]; then
  echo "IPFS_PINNING_TOKEN is not set. Add it as a GitHub Actions secret." >&2
  exit 2
fi
if [ ! -d "$ROOT" ]; then
  echo "not a directory: $ROOT" >&2
  exit 2
fi

ARGS=""
# Build a curl config so filenames with spaces survive.
CONFIG=$(mktemp)
trap 'rm -f "$CONFIG"' EXIT
find "$ROOT" -type f | sort | while IFS= read -r file; do
  rel=${file#"$ROOT"/}
  printf 'form = "file=@%s;filename=%s"\n' "$file" "$rel" >> "$CONFIG"
done
printf 'form = "pinataMetadata={\\"name\\":\\"grokwallet-approval\\"}"\n' >> "$CONFIG"
printf 'form = "pinataOptions={\\"cidVersion\\":1}"\n' >> "$CONFIG"
printf 'header = "Authorization: Bearer %s"\n' "$IPFS_PINNING_TOKEN" >> "$CONFIG"
printf 'url = "https://api.pinata.cloud/pinning/pinFileToIPFS"\n' >> "$CONFIG"
printf 'silent\nshow-error\nfail\n' >> "$CONFIG"

RESPONSE=$(curl --config "$CONFIG")
python3 - "$RESPONSE" <<'PY'
import json, sys
payload = json.loads(sys.argv[1])
cid = payload.get("IpfsHash") or payload.get("cid")
if not cid:
    sys.stderr.write("pinning response did not include a CID\n")
    sys.exit(1)
print(cid)
PY
