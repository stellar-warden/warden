# blend-yield-claim

The RFP's first walkthrough, runnable offline: an agent may claim yield from a
Blend-shaped pool and pay two known contributors up to a weekly USDC cap —
and can do nothing else.

```bash
pnpm tsx examples/blend-yield-claim/make-recording.ts
cargo test --manifest-path ../../contracts/generated/warden_policy_blend/Cargo.toml
```

The script prints the plain-English policy, the open questions the inference
surfaced (amount → cap generalization), and where the generated crate landed.
CI runs exactly this as the `differential` job.

## Live testnet run

`run-testnet.ts` is the same flow against real deployed contracts — record via
live simulation, synthesize, prove with the generated harness, install with the
owner's signature, then demonstrate the policy holding under consensus. The
inferred policy is installed exactly as proposed — nothing is loosened to fit
the account:

```bash
scripts/deploy-testnet.sh                 # deploys + seeds, writes testnet.json
export WARDEN_OWNER_SECRET=$(stellar keys show warden-owner)
export WARDEN_SESSION_SECRET=$(stellar keys show warden-session)
export WARDEN_DEPLOYER_SECRET=$(stellar keys show warden-deployer)
pnpm tsx examples/blend-yield-claim/run-testnet.ts
```

The run below is committed as [`testnet-run.json`](testnet-run.json) — every
hash is verifiable on [stellar.expert](https://stellar.expert/explorer/testnet)
(testnet data, labeled as such):

| Step | Tx | Result |
|---|---|---|
| `add_signer` (owner-signed install) | [`0fb75fa9…`](https://stellar.expert/explorer/testnet/tx/0fb75fa91f7a7e451195c48a50112456f43dec1ba7992d2c97bbd32b3ebf046f) | ✅ policy live on [`CBNJFZ5I…T2YT`](https://stellar.expert/explorer/testnet/contract/CBNJFZ5IYUFKZHNBPH6HECBLGXGBKSTQV3WLNLGO4RVOPB2PWLSYT2YT) |
| session key claims yield | [`dffd3ce2…`](https://stellar.expert/explorer/testnet/tx/dffd3ce2ea2b7c796236aa9235af28399593b12d29a8f49c59cdc8e47d4a75b0) | ✅ permitted by rule 1 |
| payroll transfer, 120 ≤ cap 150 | [`eb4aa452…`](https://stellar.expert/explorer/testnet/tx/eb4aa4523ede3f49cbec78087c61384c8c832b738e464fdcf21d317660902f22) | ✅ permitted by rule 2 |
| second transfer, sum 240 > cap 150 | [`f320d711…`](https://stellar.expert/explorer/testnet/tx/f320d7111ae4e96a85fd17cfa4c86778edf6eeb4321ef3b876dd97c67c9bb984) | ❌ **rejected on-chain** — `__check_auth` `CapExceeded`, ledger 5072224 |

The deny transaction was simulated while the rolling counter was still empty
(exactly what a leaked or greedy session key would do) and rejected by
validators when it landed after the first transfer — the cap is enforced by
consensus, not by the client. The payee's final balance is exactly one
transfer's worth.
