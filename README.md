# warden

**Record a transaction once. Get an on-chain policy that permits exactly that — proven by tests, enforced by consensus.**

warden is an AI-assisted policy builder for Stellar smart accounts (Soroban C-addresses). It watches you demonstrate a flow (claim yield, pay contributors, make a bounded swap), synthesizes the minimal authorization rules that permit that flow and nothing else, proves the rules with a generated permit/deny test suite, and produces the unsigned transaction that installs them — so an AI agent (or any session key) can act under provably scoped authority.

Built toward the SCF **OZ Accounts Policy Builder** RFP — see [docs/RFP-MAPPING.md](docs/RFP-MAPPING.md).

## Why

Giving an agent your secret key gives it *everything*. Soroban's custom accounts invert that: the protocol invokes your account contract's `__check_auth` for every authorization, so authority can be code. The hard part is *writing* that code — deny-by-default Rust with argument decoding, rolling counters, and edge cases is audit-grade work per policy. warden makes it: demonstrate → review in plain English → verify → install.

The model never holds authority. It proposes; zod schemas, a reference evaluator, generated Rust tests, and finally the chain dispose. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the trust model and the differential guarantee.

## Quickstart (offline, 2 minutes)

```bash
pnpm install && pnpm build && pnpm test          # TS pipeline + unit tests
cargo test --manifest-path contracts/Cargo.toml  # policy-core + smart-account-lite
pnpm tsx examples/blend-yield-claim/make-recording.ts
cargo test --manifest-path contracts/generated/warden_policy_blend/Cargo.toml
```

That last command compiles a policy that was *synthesized from a recording* and runs its generated permit/deny matrix under the real soroban-sdk.

## Live on testnet

The full loop — record → synthesize → verify → install → **enforced by consensus** — runs
against deployed contracts. A committed run
([examples/blend-yield-claim/testnet-run.json](examples/blend-yield-claim/testnet-run.json)):
the owner installs a synthesized policy on a deployed
[smart-account-lite](https://stellar.expert/explorer/testnet/contract/CBNJFZ5IYUFKZHNBPH6HECBLGXGBKSTQV3WLNLGO4RVOPB2PWLSYT2YT)
instance, a session key claims yield and makes a payroll transfer within its cap
(both permitted), and a second transfer that busts the weekly cap is
[**rejected on-chain**](https://stellar.expert/explorer/testnet/tx/f320d7111ae4e96a85fd17cfa4c86778edf6eeb4321ef3b876dd97c67c9bb984)
by `__check_auth`. Reproduce with `scripts/deploy-testnet.sh` +
`pnpm tsx examples/blend-yield-claim/run-testnet.ts` — see the
[example README](examples/blend-yield-claim/README.md) for all four transaction hashes.

## Talk to it (MCP)

Copy `.mcp.json.example` into your Claude configuration (adjust paths), then:

> "Record a transfer of 150 USDC from my account to Alice, propose a policy for my payroll agent's key, explain it, run the harness, and build the install transaction."

Tools: `record_flow` · `propose_policy` · `refine_policy` · `explain_policy` · `synthesize_rust` · `run_harness` · `build_install_tx`. Installation always returns **unsigned** XDR for the owner's key — warden never signs, never holds keys.

Headless equivalents: `warden record|propose|refine|explain|synth|test|install` (see `packages/cli`). The CLI also closes the loop the MCP server deliberately leaves open: `warden install --submit` signs the install as the owner and submits it, and `warden invoke` makes a call as the session key — printing `PERMITTED: tx <hash>` or `DENIED: <reason>`. Keys come from `WARDEN_OWNER_SECRET` / `WARDEN_SESSION_SECRET` / `WARDEN_FEE_SECRET` in the environment, never from flags.

## Layout

```
packages/core         PolicySpec IR (zod) + Recording model + deterministic explain
packages/recorder     raw Soroban RPC, auth-entry extraction (only pkg touching XDR-in)
packages/synthesizer  infer · reference evaluator · deny-case generator · Rust codegen · verify-gated LLM advisor
packages/harness      writes generated crates, runs cargo test, parses results
packages/mcp-server   the conversational front door (stdio MCP)
packages/sdk          PolicySpec → compact on-chain rules + unsigned add_signer tx
packages/cli          same pipeline, headless
contracts/policy-core         audited-once primitives: rolling counters, typed arg accessors
contracts/smart-account-lite  reference custom account: __check_auth over compact rules (arg matches + rolling cap)
contracts/fixtures            mock SEP-41 token + Blend-shaped pool for walkthroughs
examples/blend-yield-claim    full offline pipeline run (CI: `differential` job)
```

## Environment

`WARDEN_RPC_URL` (default testnet) · `WARDEN_NETWORK_PASSPHRASE` · `WARDEN_HOME` (state dir, default `.warden`) · `WARDEN_GENERATED_DIR` · `WARDEN_POLICY_CORE` (cargo path dep for generated crates) · `ANTHROPIC_API_KEY` + `WARDEN_MODEL` (only for `--model` advisor refinement; the pipeline is fully functional without any model).

## Status & roadmap

The full record→propose→synthesize→verify→install loop runs end-to-end on testnet against the bundled `smart-account-lite` account (see **Live on testnet** above). Tranche work (tracked in RFP-MAPPING.md): OpenZeppelin smart-accounts codegen backend, Claude Skill packaging, wallet-embedded UX with a C-Address-cohort wallet, the SEP-41 subscription and bounded-Soroswap walkthroughs on testnet, fee-sponsored installs, and an external audit of the synthesizer.

Apache-2.0. Built in the open.
