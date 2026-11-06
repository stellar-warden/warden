# RFP Mapping — OZ Accounts Policy Builder

How this codebase maps onto the SCF RFP's deliverables. Legend: ✅ working in this scaffold · 🔶 seam exists, tranche work · ⬜ tranche work.

| RFP deliverable | Status | Where / plan |
|---|---|---|
| Record or simulate a Stellar transaction sequence | ✅ | `@stellar-warden/recorder` — raw RPC `simulateTransaction`, full `SorobanAuthorizationEntry` tree extraction (root + sub-invocations) |
| Synthesize context rule + minimum set of policies | ✅ (own IR) / 🔶 (OZ form) | `inferPolicy` produces least-authority `PolicySpec`; `generateCrate` emits enforcing Rust. OZ adapter = codegen backend targeting OZ context-rule/policy contracts, developed against the pinned OZ release with OZ as reviewer (tranche 1–2) |
| Output compilable Rust (Soroban) | ✅ | Deterministic templates; standalone crate; CI compiles and tests it |
| Simulation harness with permit AND deny cases | ✅ | `denygen` mutation matrix + generated `tests/permit_deny.rs`; window accumulation/reset sequence tests; differential check vs TS reference evaluator |
| AI-assisted (MCP server + agent skill) | ✅ MCP / ⬜ skill | `@stellar-warden/mcp-server`: record_flow, propose_policy, refine_policy, explain_policy, synthesize_rust, run_harness, build_install_tx. Claude Skill = thin instruction layer over the same tools (tranche 1) |
| Wallet integration: record → generate → simulate → install | 🔶 | Full loop works headless (CLI/MCP → unsigned `add_signer` XDR for owner signature). Wallet-embedded UX with a C-Address-cohort wallet partner = tranche 2–3 |
| Three documented walkthroughs (Blend yield; SEP-41 subscription; bounded Soroswap delegation) | 🔶 | `examples/blend-yield-claim` runs offline in CI **and live on testnet** (`run-testnet.ts`, hashes in `testnet-run.json`); subscription + Soroswap walkthroughs = tranche 2 |
| Audit of the synthesizer itself | ⬜ | Scoped for Audit Bank at tranche 3; the deliberately small trusted base (policy-core + templates + lite account, see ARCHITECTURE.md) is the audit-cost argument |

## Tranche sketch (10 / 20 / 30 / 40)

- **T0 (10%)** — this scaffold hardened: OZ crate pinned, adapter design doc reviewed by OZ, Claude Skill draft. ✅ *Done ahead of tranche:* testnet deployment of mock-protocols + smart-account-lite with a scripted end-to-end run (`scripts/deploy-testnet.sh` + `examples/blend-yield-claim/run-testnet.ts`, permit/deny hashes committed).
- **T1 (20%)** — OZ codegen backend (context rules + spending-limit/allowlist policies), differential harness extended to run identical cases against OZ policies; SEP-41 subscription walkthrough.
- **T2 (30%)** — wallet integration with a C-Address-cohort wallet (record→install UX), Soroswap bounded-delegation walkthrough, fee-sponsored install flow via OZ Relayer/Launchtube.
- **T3 (40%)** — audit (Audit Bank) + fixes, docs site, mainnet-ready release, UX-readiness evidence per SCF v7 final-tranche requirements.

## Evaluation-criteria alignment (why this team)

- *Shipped MCPs / agent tooling*: this repo ships a working MCP server; prior art includes a verify-gated agent harness (plan→act→verify→repair with JSON-schema gating) — the same discipline the advisor implements.
- *Rust + TypeScript across the stack*: policy-core/smart-account-lite (Rust) + the full TS pipeline, tests on both sides, one CI.
- *Building in the open*: Apache-2.0, deterministic codegen (reviewable diffs), reference outputs committed.
