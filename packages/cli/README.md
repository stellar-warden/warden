# @stellar-warden/cli

Record a Stellar flow once. Get an on-chain policy that permits exactly that — enforced by consensus.

warden synthesizes least-authority policies for Soroban smart accounts (C-addresses) from a demonstrated transaction, so an AI agent or session key can act under provably scoped authority.

## Try it (no clone, no keys, ~minutes)

```bash
npx @stellar-warden/cli demo
```

`demo` runs the whole loop on **Stellar testnet** with throwaway keys (funded by friendbot):

1. deploys a fresh `smart-account-lite` plus a **mock** token and a **mock** yield pool (wasm ships in this package)
2. **records** a yield claim and a payroll transfer by simulating them against the live contracts
3. **proposes** the least-authority policy and prints it in plain English
4. **installs** it (the owner key signs `add_signer`)
5. **proves** it: the session key claims yield ✓, transfers within the weekly cap ✓, then a second transfer that busts the cap is **rejected on-chain** by `__check_auth` ✗

Every contract and transaction is printed as a stellar.expert link. Testnet only — the token and pool are labelled mocks, and nothing here is audited.

## Commands

```
warden demo                                              whole loop on testnet, fresh keys
warden record  --account C.. --source G.. --contract C.. --method transfer --args '[...]'
warden propose --recording <id> --signer <hex64>
warden explain --recording <id>
warden install --recording <id> --source G..             prints UNSIGNED xdr for the owner
warden install --recording <id> --submit                 owner signs + submits
warden invoke  --account C.. --contract C.. --method transfer --args '[...]'
                                                         session key acts under the policy
warden synth | test --recording <id>                     generate / cargo-test the Rust policy crate
```

`synth` and `test` need a Rust toolchain and a checkout of the repo (they compile the generated crate against `contracts/policy-core`). Everything else works from the npm package alone.

Keys are read from `WARDEN_OWNER_SECRET`, `WARDEN_SESSION_SECRET` and `WARDEN_FEE_SECRET`, never from flags. warden never signs for you in the MCP flow and never holds keys.

Apache-2.0.
