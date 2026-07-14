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

For the on-network version of the same flow, deploy `mock-protocols` +
`smart-account-lite` to testnet and use `warden record` / the MCP
`record_flow` tool instead of the fixture builder.
