#!/usr/bin/env bash
# Rebuild the contract wasms and copy the ones `warden demo` deploys into the CLI package.
# Run after any change under contracts/smart-account-lite or contracts/fixtures/mock-protocols,
# and commit packages/cli/wasm/ with it (the published CLI ships these bytes).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
(cd "$ROOT/contracts" && stellar contract build >/dev/null)
mkdir -p "$ROOT/packages/cli/wasm"
cp "$ROOT/contracts/target/wasm32v1-none/release/mock_protocols.wasm" \
   "$ROOT/contracts/target/wasm32v1-none/release/smart_account_lite.wasm" \
   "$ROOT/packages/cli/wasm/"
sha256sum "$ROOT"/packages/cli/wasm/*.wasm
