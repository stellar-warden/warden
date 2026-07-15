#!/usr/bin/env bash
# Deploy the warden walkthrough contract set to Stellar testnet.
#
# Deploys:
#   token   — an instance of contracts/fixtures/mock-protocols (MockToken fns)
#   pool    — a second instance of the same wasm (MockPool fns)
#   account — contracts/smart-account-lite, init'd with the OWNER key
# then seeds state: mints token balance to the account and sets claimable yield.
#
# Prereqs:
#   stellar keys generate warden-deployer --network testnet --fund
#   stellar keys generate warden-owner   --network testnet
#   (owner needs no funding — it only ever signs auth entries)
#
# Usage: scripts/deploy-testnet.sh [out.json]
# Writes contract IDs + key addresses to examples/blend-yield-claim/testnet.json
# (or the path given), and re-runs cleanly: each run deploys fresh instances.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/examples/blend-yield-claim/testnet.json}"
NETWORK="${WARDEN_NETWORK:-testnet}"
DEPLOYER="${WARDEN_DEPLOYER:-warden-deployer}"
OWNER="${WARDEN_OWNER:-warden-owner}"

WASM_DIR="$ROOT/contracts/target/wasm32v1-none/release"
MOCK_WASM="$WASM_DIR/mock_protocols.wasm"
ACCOUNT_WASM="$WASM_DIR/smart_account_lite.wasm"

echo "building wasms…"
(cd "$ROOT/contracts" && stellar contract build >/dev/null)

deploy() { # deploy <wasm> -> contract id on stdout
  stellar contract deploy --wasm "$1" --source-account "$DEPLOYER" --network "$NETWORK" 2>/dev/null
}

echo "deploying mock token…"
TOKEN=$(deploy "$MOCK_WASM")
echo "  $TOKEN"
echo "deploying mock pool…"
POOL=$(deploy "$MOCK_WASM")
echo "  $POOL"
echo "deploying smart-account-lite…"
ACCOUNT=$(deploy "$ACCOUNT_WASM")
echo "  $ACCOUNT"

# init(owner): BytesN<32> = the owner G-address' raw ed25519 public key.
OWNER_G=$(stellar keys address "$OWNER")
OWNER_HEX=$(python3 - "$OWNER_G" <<'EOF'
import base64, binascii, sys
g = sys.argv[1]
raw = base64.b32decode(g)
print(binascii.hexlify(raw[1:33]).decode())
EOF
)
echo "init account with owner $OWNER_G…"
stellar contract invoke --id "$ACCOUNT" --source-account "$DEPLOYER" --network "$NETWORK" \
  -- init --owner "$OWNER_HEX" >/dev/null

echo "seeding: mint 1000 units (1e10 stroop-ish) to the account, set 70 yield…"
stellar contract invoke --id "$TOKEN" --source-account "$DEPLOYER" --network "$NETWORK" \
  -- mint --to "$ACCOUNT" --amount 10000000000 >/dev/null
stellar contract invoke --id "$POOL" --source-account "$DEPLOYER" --network "$NETWORK" \
  -- set_yield --user "$ACCOUNT" --amount 700000000 >/dev/null

DEPLOYER_G=$(stellar keys address "$DEPLOYER")
cat >"$OUT" <<EOF
{
  "network": "testnet",
  "rpcUrl": "https://soroban-testnet.stellar.org",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "token": "$TOKEN",
  "pool": "$POOL",
  "account": "$ACCOUNT",
  "owner": "$OWNER_G",
  "deployer": "$DEPLOYER_G"
}
EOF
echo "wrote $OUT"
