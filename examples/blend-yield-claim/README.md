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
owner's signature, then demonstrate the policy holding under consensus:

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
| `add_signer` (owner-signed install) | [`669e6647…`](https://stellar.expert/explorer/testnet/tx/669e66472d061dd1790a49772ae787b999c582df28fe9726f6bcd0d3ed77976b) | ✅ policy live on [`CA6ZBKTM…YHCU`](https://stellar.expert/explorer/testnet/contract/CA6ZBKTMVZC66Q4VGGSZCCEVCPCBWNENE3H7NORVMKAJOZQSOOX2YHCU) |
| session key claims yield | [`e55d9fc1…`](https://stellar.expert/explorer/testnet/tx/e55d9fc1b53dbdf7b281d415f463b4aa2a93312b62a0475ad786637cea200e68) | ✅ permitted by rule 1 |
| payroll transfer, 120 ≤ cap 150 | [`ad238e0c…`](https://stellar.expert/explorer/testnet/tx/ad238e0c4308d21f18738aa18d1b9143645dfe01ffc12dc1ebcf927ba51e545c) | ✅ permitted by rule 2 |
| second transfer, sum 240 > cap 150 | [`eb13f103…`](https://stellar.expert/explorer/testnet/tx/eb13f1030478c5acf9c5fb2232a504ca775f5870c2782d203f06265b3c785510) | ❌ **rejected on-chain** — `__check_auth` `CapExceeded`, ledger 3614696 |

The deny transaction was simulated while the rolling counter was still empty
(exactly what a leaked or greedy session key would do) and rejected by
validators when it landed after the first transfer — the cap is enforced by
consensus, not by the client. The payee's final balance is exactly one
transfer's worth.
