# Architecture

## One paragraph

warden turns a **demonstrated transaction flow** into an **on-chain authorization policy** that permits exactly that flow and nothing else. A model may help decide *how much* to generalize (is `1500000000` a fixed amount or a weekly cap?), but authority lives entirely in deterministic layers: a zod-validated intermediate representation, template-based Rust codegen, a generated permit/deny test suite executed under the real soroban-sdk, and a smart-account contract whose `__check_auth` the Stellar protocol itself invokes.

## Pipeline

```
            facts                    judgment                  determinism
  ┌───────────────────┐   ┌───────────────────────┐   ┌────────────────────────┐
  │ @stellar-warden/recorder  │   │ @stellar-warden/synthesizer    │   │ @stellar-warden/synthesizer    │
  │ simulate tx via   │──▶│ infer: least-authority │──▶│ codegen: PolicySpec →  │
  │ raw RPC, extract  │   │ draft + questions      │   │ Rust crate + tests     │
  │ auth entry trees  │   │ advisor: LLM refines,  │   └───────────┬────────────┘
  └───────────────────┘   │ schema+eval gated      │               │
                          └───────────────────────┘               ▼
  ┌───────────────────┐   ┌───────────────────────┐   ┌────────────────────────┐
  │ smart-account-lite│◀──│ @stellar-warden/sdk            │◀──│ @stellar-warden/harness        │
  │ __check_auth      │   │ unsigned add_signer tx │   │ cargo test: every      │
  │ enforces on-chain │   │ (owner signs off-band) │   │ permit + deny case     │
  └───────────────────┘   └───────────────────────┘   └────────────────────────┘
```

Interfaces to the same pipeline: `@stellar-warden/mcp-server` (conversational, for Claude or any MCP client) and `@stellar-warden/cli` (headless, for humans and CI). Both are thin; neither adds authority.

## The IR is the system

`PolicySpec` (packages/core/src/policyspec.ts) is the single source of truth. Consequences, by construction:

- **Explain = code.** The English explanation and the Rust are rendered from the same spec; they cannot drift.
- **Verify-gated model participation.** The advisor loop is plan→act→verify→repair: the model outputs JSON; zod rejects malformed output with readable issues fed back for repair (max 3 attempts, then the heuristic draft stands). A separate invariant check refuses refinements that change the account, the signer, or add call targets not present in the recording. Nothing the model writes ever reaches codegen unparsed.
- **Deny-by-default is structural.** `denyUnmatched: z.literal(true)` and every argIndex requiring an explicit constraint (`any` must be *stated*) make silent permissiveness unrepresentable, not just discouraged.

## The differential guarantee

Two independent implementations of the same semantics:

1. `packages/synthesizer/src/eval.ts` — a pure-TS reference evaluator
2. the generated Rust, executed by the harness under soroban-sdk testutils

The deny-case generator produces one case matrix; TS unit tests assert every case against the evaluator, the harness asserts the same cases against the compiled policy. Any divergence is a codegen bug and fails CI. Window/counter semantics (rolling start, reset on elapse, overflow-checked sums, negative-amount rejection) are additionally pinned by hand-written tests on both sides (`pipeline.test.ts`, `policy-core/src/lib.rs`).

Deny cases mutate only along axes that are safe to construct (function name, arg count, out-of-set values, over-cap and negative amounts, foreign contracts drawn from addresses already in the recording — strkeys are checksummed, so we never invent them).

## Trust model

| component | trusted to | NOT trusted to |
|---|---|---|
| model (advisor / MCP client) | propose, explain, orchestrate | hold keys, widen policy, emit code |
| synthesizer | generate faithfully from spec | decide policy content |
| harness | prove permit/deny behavior | — |
| owner key | root authority, installs policies | — |
| session key (agent) | act **within** installed rules | anything else — protocol-enforced |

The MCP server never signs. `build_install_tx` returns unsigned XDR; the owner reviews `explain_policy` output and signs out-of-band — `warden install --submit` does it locally with keys read from the owner's own environment, outside any model's reach. A prompt-injected client therefore caps out at: proposing a policy the owner still has to read and sign, or acting within an already-installed policy.

## Seams (deliberate, documented)

- **smart-account-lite vs generated crates.** The lite contract enforces compact rules: any number of exact/allowlist argument matches (compared on-chain as raw values, so every argument type is covered) plus one rolling cap per rule, with counters kept per session signer. That is everything `inferPolicy` produces, so an inferred spec installs unedited; `@stellar-warden/sdk` *refuses* the remainder (a second cap on one rule, two rules for one function) rather than approximating. Full-fidelity enforcement of those is the generated crate embedded in an account, and the **OpenZeppelin smart-accounts adapter** (tranche work): mapping PolicySpec onto OZ context rules + policies is a codegen backend swap — the IR, evaluator, deny generator, and harness are unchanged.
- **Fees.** Session agents hold no XLM; installs and agent transactions are expected to flow through a fee-sponsoring relayer (OZ Relayer / Launchtube pattern). Out of scope here, by design.
- **Counter storage rent.** `Counters` persists under one persistent key; TTL bumping is the account's job (extend in `__check_auth` — tracked as tranche work in RFP-MAPPING.md).
- **Classic interop.** Payouts to G-addresses via SAC transfers work; SEP flows that assume classic accounts need the corridor-side smoothing described in the roadmap.

## Where a model runs in production

Two places, both fenced: the advisor (spec refinement, schema+eval gated) and whatever MCP client drives the tools (orchestration only). The enforcement path — policy-core, generated crates, smart-account-lite — contains no model, no network, no nondeterminism.
