# PRD — `examples/anchor-withdraw` (warden roadmap tranche)

**Working name:** Anchor Withdraw Recipe
**Version:** 1.0 · 2026-09-16
**Status:** Proposal. Not started, not funded, not committed to any RFP tranche. This document is scoped as an appendix to `docs/RFP-MAPPING.md` and `plan.md`, not a new company or a modification to warden's core packages.
**Evidence labels:** VERIFIED (established via deep-research adversarial verification, Sept 2026, against primary sources: docs.rs, crates.io, GitHub) · READ (confirmed directly from warden's own repository files on 2026-09-16) · PROPOSED (design decision made for this document, not yet built or agreed by any third party).

---

## 1. Summary

warden already proves a narrow claim well: record a demonstrated flow, synthesize the minimal deny-by-default policy that permits exactly that flow, prove it with generated tests, install it as an unsigned `add_signer` transaction, and watch a real testnet `__check_auth` reject anything outside the cap. The existing worked example, `examples/blend-yield-claim`, demonstrates this against a DeFi yield-claim-and-payroll flow.

This PRD proposes a second worked example, `examples/anchor-withdraw`, that demonstrates the identical loop against a different, high-value flow shape: an agent-initiated withdrawal that would, in a real deployment, route through a Stellar Anchor's SEP-24 interactive flow. The motivating gap is real and recent: a published crate (`stellar-agent-anchor`, Soneso, five weeks old at time of research) already lets an AI agent *discover* anchor withdrawal terms and *retrieve* the SEP-24 interactive URL over MCP — but it deliberately stops there. It does not call the anchor's `/withdraw` endpoint, does not transmit KYC data, and does not follow the interactive URL. A human finishes the fiat leg every time. This PRD's thesis is that the missing piece is not more anchor API surface — it is a **provable reason for an anchor (or a wallet standing between the agent and the anchor) to trust a scoped signer with more authority than "look, don't touch."** A warden-installed policy is exactly that: not a promise, an on-chain-enforced ceiling.

This is explicitly a worked-example/roadmap proposal, not a claim that any anchor has agreed to accept a scoped signer in place of a human-completed SEP-24 flow. Phase 1 builds the example against warden's existing fixture pattern (mirroring how `blend-yield-claim` uses a mock, Blend-shaped pool rather than the real Blend protocol). Phase 2 — engaging a real anchor or the `stellar-agent-anchor` maintainers — is explicitly gated and speculative.

---

## 2. Problem and evidence

### 2.1 Pain statement

> **An AI agent that has earned or holds on-chain USDC on Stellar cannot autonomously complete a withdrawal to fiat.** A real, recent crate exists to help it *discover* how (`stellar-agent-anchor`, Soneso, `v0.1.0-alpha.6`, Apache-2.0, published 2026-08-12) — but its own documentation is explicit that it exposes exactly two MCP tools, `stellar_sep6_deposit_info` and `stellar_sep24_interactive_url`, and is deliberately incapable of calling the anchor's `/deposit`, `/withdraw`, `/deposit-exchange`, `/withdraw-exchange`, `/customer` (SEP-12), `/fee`, or `/transaction(s)` endpoints, of transmitting SEP-9 KYC fields, or of auto-opening/following the SEP-24 interactive URL it retrieves. VERIFIED across three independent primary sources (docs.rs crate documentation, crates.io registry metadata, and the GitHub repository) with a 2-1 and a 3-0 adversarial-verification vote. The crate is real (Soneso is a legitimate, known Stellar tooling vendor) but low-adoption (~81 total downloads at time of research) and pre-1.0.

> **The adjacent bounded-authority project from the same vendor does not close this gap either.** `stellar-agent-wallet` (github.com/Soneso/stellar-agent-wallet) documents rolling-window spending limits and a first-class "External-Ed25519" signer that enforces smart-account execute calls within on-chain limits — real, working prior art for bounded agent-wallet authority on Stellar. Its README describes no fiat or off-ramp capability at all. VERIFIED (2-1 vote). The two Soneso projects are complementary in principle (one bounds spend, one talks to anchors) but neither, nor their combination as documented, lets an agent finish a withdrawal without a human in the loop.

### 2.2 Why this specific gap, and why warden is a plausible answer to it

The likely reason `stellar-agent-anchor` stops at discovery is not an engineering oversight — SEP-24 interactive flows and SEP-12 KYC collection are exactly the surface where an anchor is most exposed to fraud, sanctions, and consumer-protection liability. Handing an agent-controlled key the ability to call `/withdraw` or submit KYC data on a human's behalf is a full-custody-risk proposition from the anchor's perspective, regardless of how well-intentioned the agent's operator is. **This is a hypothesis about design rationale, not a documented anchor policy** — no anchor has published a requirement or preference for scoped signers over full human-mediated KYC flows, and none should be assumed to.

warden's contribution is not an anchor integration. It is a **pre-existing, already-proven trust primitive** that happens to be a plausible answer to exactly this shape of hesitation: a policy-scoped smart account whose authority is capped (amount, counterparty, function selector) not by convention but by `__check_auth`, proven correct by a generated differential test suite, with the ceiling enforced by protocol consensus rather than trusted to client-side code. If an anchor (or a wallet acting as an intermediary) ever wanted to grant an agent more authority than "read-only discovery" without granting full custody, a warden-installed signer is a concrete, inspectable artifact they could evaluate — rather than a bespoke access-control system built and audited from scratch.

### 2.3 What exists, and why it is not this

| Project | What it does | Gap relative to this proposal |
|---|---|---|
| `stellar-agent-anchor` (Soneso, v0.1.0-alpha.6) | MCP tools for SEP-6 deposit-info discovery and SEP-24 interactive-URL retrieval | No execution surface at all (by design) — cannot call deposit/withdraw, cannot carry KYC, cannot complete the loop. VERIFIED |
| `stellar-agent-wallet` (Soneso) | Rolling-window spend caps + External-Ed25519 signer enforcing execute calls within on-chain limits | Manually-parameterized (admin sets the cap), not demonstration-synthesized; no anchor/fiat awareness at all. VERIFIED |
| warden `examples/blend-yield-claim` | Full record→synthesize→prove→install→testnet loop against a DeFi yield-claim-and-payroll flow | Proves the mechanism works generally; does not touch anchors, SEP-24, or a withdrawal-shaped flow. READ (this repository) |
| `stellar-agent-guard-contracts` (aigbagbobila) | `CustomAccountInterface`/`__check_auth` gate with admin-set `PolicyConfig` (spend caps, window, allowlists) | Same underlying Soroban primitive as warden, but policy is admin-authored, not synthesized from a recording; no anchor integration. VERIFIED (0-3 refuted as direct prior art for warden's synthesis mechanism specifically) |
| ERC-7715 / ZeroDev permissions (Ethereum ecosystem) | Standardized, real, adopted scoped/revocable execution permissions for smart accounts | Cross-chain, not Stellar; policy content is manually composed from pre-defined primitive types, not synthesized from a demonstration; no anchor-shaped precedent found either. VERIFIED |

No project — on Stellar or elsewhere — combines (a) a policy synthesized from a demonstrated flow and proven by generated tests with (b) an anchor-shaped withdrawal use case. This is a genuinely open combination, not a re-implementation of existing art.

---

## 3. Goals and non-goals

**Goals**
1. Ship a second worked example, structurally identical in rigor to `blend-yield-claim`, that exercises warden's pipeline against a withdrawal-shaped flow with a named counterparty cap and a live testnet permit/deny pair of transaction hashes.
2. Produce a concrete, inspectable artifact (the generated policy + its proof) that can be shown to an anchor, a wallet, or the `stellar-agent-anchor` maintainers as a talking point for what a "more-than-discovery, less-than-full-custody" agent signer could look like.
3. Keep the artifact honest: label every claim about anchor acceptance as aspirational, and every testnet result as testnet.

**Non-goals**
- Building, forking, or wrapping `stellar-agent-anchor` itself. This proposal produces a warden example that is *shaped like* an anchor withdrawal, using warden's own mock-fixture pattern; it does not add SEP-6/24 client code to warden's packages.
- Claiming any anchor has agreed to accept agent signers, scoped or otherwise.
- Automating SEP-12 KYC collection or SEP-24 interactive-URL following. That remains explicitly out of scope, for the same liability reasons `stellar-agent-anchor` itself avoids it.
- Modifying warden's trust model, `PolicySpec` IR, or `__check_auth` enforcement path. This is a new example built entirely on the existing pipeline (`packages/core`, `packages/recorder`, `packages/synthesizer`, `packages/harness`, `packages/sdk`, `contracts/smart-account-lite`) with a new fixture contract, mirroring how `blend-yield-claim` added `contracts/fixtures/mock-protocols` without touching the core packages.
- Any claim that this closes the fiat-bridge gap end-to-end. It closes the *authorization* half; the *money movement and KYC* half remains exactly as unsolved as `stellar-agent-anchor`'s own documentation says it is.

---

## 4. Users and jobs to be done

| Persona | Job | Today | What this example gives them |
|---|---|---|---|
| SCF / OZ Accounts Policy Builder RFP reviewer | "Does this team's synthesis approach generalize past the one demo flow they shipped?" | One worked example (Blend yield claim) | A second, structurally different worked example (withdrawal-to-counterparty) proving the pipeline is not overfit to one shape of flow |
| `stellar-agent-anchor` maintainers (Soneso) or any anchor evaluating agent access | "If I wanted to let an agent do more than discover terms, what would bound it?" | Nothing — the crate stops at discovery by design | A concrete, runnable artifact: a policy that permits exactly "withdraw ≤ X/week to this one counterparty contract" and rejects everything else, proven on testnet |
| warden's own roadmap / next SCF wave committee | "Is this team shipping category-defining examples, or just the one they needed for the RFP?" | One example | Evidence of a second, independently-motivated use case, sourced from real ecosystem research rather than invented for the grant |

---

## 5. Product scope by phase

### Phase 1 — Build the example against fixtures (proposed, unscheduled)

**Work:**
- Add `contracts/fixtures/mock-anchor` — a minimal Soroban contract shaped like the on-chain leg of an anchor withdrawal: a single `withdraw(from: Address, amount: i128, memo: Option<u64>)` entry point that debits a SEP-41-shaped balance and emits an event, mirroring how `contracts/fixtures/mock-protocols` stands in for Blend's `claim`. This is a **mock**, not a fork of any real anchor contract — no real anchor exposes a directly-callable Soroban withdrawal entry point today (real anchors settle via classic-account SEP-31/SEP-6/24 flows, off-chain rails, and G-address payments, not a bespoke Soroban call). The mock exists purely so the recorded flow has something concrete to call, exactly as `mock-protocols` stands in for Blend.
- Add `examples/anchor-withdraw/make-recording.ts`, following `blend-yield-claim/make-recording.ts`'s shape: record a `withdraw` call to the mock-anchor contract for a bounded amount, run it through `propose_policy` → `explain_policy` → `synthesize_rust` → `run_harness`, and print the plain-English policy plus the open questions the inference surfaces (is the recorded amount a per-call cap, a weekly cap, or a total lifetime cap? — this is a real, useful design question the recording-based approach forces the operator to answer explicitly, exactly as it did for the Blend example's payroll cap).
- Deny-case generation should specifically exercise the axes that matter for a withdrawal policy: wrong counterparty (a different contract address than the one demoed, drawn from an address already present in the recording per warden's existing deny-generation rule of never inventing new strkeys), over-cap amount, and wrong function selector (e.g. a hypothetical `withdraw_exchange` call not present in the recording).

**Acceptance:** `pnpm tsx examples/anchor-withdraw/make-recording.ts` produces a plain-English policy explanation, a generated Rust crate, and passing differential tests (TS reference evaluator vs. compiled Soroban policy), exactly matching the existing CI `differential` job pattern for `blend-yield-claim`.

### Phase 2 — Live testnet run (proposed, unscheduled, depends on Phase 1)

**Work:**
- Deploy `mock-anchor` alongside the existing `mock-token`/`mock-protocols`/`smart-account-lite` set via `scripts/deploy-testnet.sh`, following the exact deployment order and script pattern already used (see `plan.md` Workstream 1.1).
- Add `examples/anchor-withdraw/run-testnet.ts`, mirroring `blend-yield-claim/run-testnet.ts`: live `simulateTransaction` against the deployed mock-anchor, synthesis from the live recording, owner-signed `add_signer` install, and two captured testnet transaction hashes:
  1. **Permit path** — a withdrawal within the weekly cap to the demoed counterparty, succeeding on-chain.
  2. **Deny path** — a withdrawal either over the cap or to a different counterparty contract, rejected on-chain by `__check_auth`.
- Document both hashes, the contract IDs, and reproduction commands in `examples/anchor-withdraw/README.md` under a "Live testnet run" section, in the same table format as `blend-yield-claim/README.md`. Label everything testnet, per the project's own stated policy that "a broken live claim is worse than no claim."

**Acceptance:** two independently verifiable testnet transaction hashes (one success, one `__check_auth` rejection), reproducible from committed scripts, exactly matching the existing example's acceptance bar.

### Phase 3 — Ecosystem conversation (explicitly speculative, not planned)

**Work (contingent, not committed):** Share the finished example with the `stellar-agent-anchor` maintainers or a real anchor's engineering contact as a concrete artifact — "here is what a scoped signer looks like and how it's proven" — to learn whether a scoped-signer requirement is something an anchor would ever consider as an alternative or supplement to full human-mediated KYC for agent-initiated withdrawals below some threshold. **No outcome of this conversation should be assumed.** It is plausible the answer is "no, regulatory/KYC obligations attach regardless of on-chain authority scoping" — that would be a valid and useful finding, not a failure of this phase.

---

## 6. Architecture

### 6.1 System diagram (textual)

```
  ┌─────────────────────────────┐
  │ examples/anchor-withdraw     │
  │  make-recording.ts (offline) │
  │  run-testnet.ts (live)       │
  └──────────────┬───────────────┘
                 │ record a withdraw() call
                 ▼
  ┌─────────────────────────────┐        ┌──────────────────────────┐
  │ @warden/recorder             │───────▶│ contracts/fixtures/       │
  │ simulateTransaction against  │        │   mock-anchor (new)       │
  │ the deployed/local fixture   │        │ withdraw(from, amount,    │
  └──────────────┬───────────────┘        │   memo) → debit + event   │
                 │ auth-entry tree         └──────────────────────────┘
                 ▼
  ┌─────────────────────────────┐
  │ @warden/synthesizer          │
  │ infer: cap type question     │
  │ (per-call / weekly / total)  │
  │ denygen: wrong counterparty, │
  │ over-cap, wrong function     │
  └──────────────┬───────────────┘
                 │ PolicySpec + generated Rust
                 ▼
  ┌─────────────────────────────┐        ┌──────────────────────────┐
  │ @warden/harness               │───────▶│ contracts/generated/      │
  │ cargo test: permit + deny     │        │   warden_policy_anchor_   │
  │ matrix under real soroban-sdk │        │   withdraw (new crate)    │
  └──────────────┬───────────────┘        └──────────────────────────┘
                 │ tests pass
                 ▼
  ┌─────────────────────────────┐        ┌──────────────────────────┐
  │ @warden/sdk                   │───────▶│ smart-account-lite         │
  │ unsigned add_signer XDR        │        │ (existing testnet          │
  │ (owner signs off-band)         │        │  instance or a fresh one)  │
  └─────────────────────────────┘        │ __check_auth enforces on-  │
                                          │ chain, same as blend       │
                                          │ example                    │
                                          └──────────────────────────┘
```

### 6.2 Components

| Component | Responsibility | Reused from warden (unchanged) | New for this example |
|---|---|---|---|
| `mock-anchor` fixture | Stand-in for the on-chain leg of a withdrawal call | Cargo/Soroban project scaffolding, `contracts/fixtures/mock-protocols` as a template | New Rust contract: `withdraw(from, amount, memo)` |
| Recording | Capture the demoed flow | `@warden/recorder`, RPC client (`packages/recorder/src/rpc.ts`) unchanged | New recording script, new recorded call shape |
| Synthesis | Infer minimal policy, generate deny cases, codegen | `@warden/synthesizer` entirely unchanged | None — this is the point: the existing inference/denygen/codegen pipeline should require zero changes to handle a new contract shape, since it operates on the generic `SorobanAuthorizationEntry` tree, not domain-specific logic |
| Proof | Differential test execution | `@warden/harness`, `contracts/policy-core` unchanged | New generated crate, `contracts/generated/warden_policy_anchor_withdraw` |
| Install | Unsigned `add_signer` XDR | `@warden/sdk`, `contracts/smart-account-lite` unchanged | None |
| Example scripts/docs | Reproducible walkthrough | `blend-yield-claim`'s script shape and README table format as direct templates | `examples/anchor-withdraw/*` |

### 6.3 Key technical decisions

1. **Use a mock contract, not a real anchor integration.** Real anchors do not expose a directly-callable Soroban withdrawal entry point (SEP-31/SEP-6/24 settle via classic-account rails and off-chain APIs, not a bespoke on-chain call an agent's smart account would invoke directly). Building against a mock keeps the example honest about what it proves (the synthesis pipeline generalizes to a withdrawal-shaped call) without overclaiming anchor integration that does not exist. PROPOSED.
2. **No new warden package or core-pipeline change.** The entire point of this example is to demonstrate that `packages/synthesizer`'s generic inference over `SorobanAuthorizationEntry` trees already handles an unseen contract shape without modification — a stronger proof of the IR's generality than adding special-cased "anchor mode" logic would be. PROPOSED, consistent with `docs/ARCHITECTURE.md`'s statement that the IR is domain-agnostic.
3. **The recording-forced design question is a feature, not friction.** Exactly as the Blend example forced an explicit choice about whether the demoed amount was a fixed value or a weekly cap, this example will force an explicit choice about whether a withdrawal cap is per-call, weekly, or a lifetime total — surfacing this as an open, human-reviewed question (via `explain_policy`) is precisely the trust model warden already commits to (advisor proposes, human reviews, chain disposes). READ from `docs/ARCHITECTURE.md`.
4. **No KYC, no SEP-24 URL handling, anywhere in this example.** To avoid any appearance of encroaching on `stellar-agent-anchor`'s deliberately-scoped-out territory, this example never touches SEP-6/24/12 endpoints, real or mocked. It only demonstrates the authorization primitive. PROPOSED.

---

## 7. Data model

No new persistent data model beyond what warden's pipeline already produces per run:

| Artifact | Shape | Source |
|---|---|---|
| `recording.json` | Existing `Recording` model (packages/core) — unchanged shape, new contents (a `withdraw` call instead of a `claim`/`transfer` pair) | `@warden/recorder` output |
| `PolicySpec` (in-memory / generated crate) | Existing IR — one rule for `withdraw`, allowlisting the demoed counterparty and memo pattern, with a rolling-window cap on `amount` | `@warden/synthesizer` output |
| `testnet.json` | Existing shape (contract IDs) — extended with the new `mock-anchor` contract ID | `scripts/deploy-testnet.sh` |
| `testnet-run.json` | Existing shape (recorded run + tx hashes) — new run for this example | `run-testnet.ts` output |

---

## 8. Interfaces

No new CLI flags, MCP tools, or SDK functions are proposed. The existing surface (`record_flow`, `propose_policy`, `refine_policy`, `explain_policy`, `synthesize_rust`, `run_harness`, `build_install_tx` over MCP; `warden record|propose|explain|synth|test|install` headless) is exercised end-to-end against the new fixture, exactly as it already is against `blend-yield-claim`. If this proves false during implementation — if the mock-anchor's call shape genuinely requires new capability in the synthesizer — that finding itself would be valuable (see §14, Risks) and should be written up rather than quietly special-cased.

---

## 9. Security, compliance, and custody position

- **No custody, no key material, no change to warden's trust model.** This example does not alter warden's stated posture: the model never holds authority, the MCP server never signs, `build_install_tx` returns unsigned XDR only, and the owner reviews and signs out-of-band. READ from `docs/ARCHITECTURE.md`, unchanged by this proposal.
- **No KYC or PII of any kind.** The mock-anchor fixture never collects, stores, or transmits SEP-9 KYC fields or any real-world identity data. It is a bare Soroban debit-and-event contract.
- **No claim of anchor endorsement.** Every document produced by this example (README, generated policy explanation) must state plainly that no anchor has adopted, endorsed, or been consulted about this pattern as of publication, to avoid the exact "fabricated or non-working live claim" failure mode `plan.md` identifies as the one thing that gets projects penalized.
- **Testnet-only, explicitly labeled.** Same posture as `blend-yield-claim`: every transaction hash and contract ID is testnet, never presented otherwise.

---

## 10. Positioning (in place of pricing/GTM)

This is a warden roadmap tranche appendix, not a revenue-generating product on its own — it has no independent pricing or go-to-market motion. Its value is entirely in strengthening warden's own RFP and future-wave story:

- **For the current OZ Accounts Policy Builder RFP:** a second, independently-motivated worked example (sourced from real ecosystem research rather than manufactured for the grant) is direct evidence against the single biggest risk a synthesis-from-demonstration approach faces with reviewers — that it only works for the one flow it was built to demo. See §14 for the specific failure mode this addresses.
- **For ecosystem relationships:** a finished, runnable artifact is a substantially stronger opening for a conversation with the `stellar-agent-anchor` maintainers or an anchor's engineering team than an abstract pitch — "here is a policy that permits exactly this withdrawal pattern and rejects everything else, verified on testnet" is inspectable in a way a slide is not.
- **Cost:** estimated at the same order of magnitude as `blend-yield-claim` itself — one new fixture contract, two new scripts, one README section. Given the existing pipeline requires no changes (per §6.3), this is closer to a documentation-and-fixture exercise than new product engineering.

---

## 11. Metrics and acceptance criteria

Mirrors the existing band-uplift plan's own bar for "live," since that is the standard this project has already held itself to:

| Criterion | Target |
|---|---|
| Offline pipeline run | `make-recording.ts` produces policy explanation + passing differential tests, same as `blend-yield-claim` |
| Live testnet permit tx | 1 real, verifiable testnet transaction hash, within-cap withdrawal succeeds |
| Live testnet deny tx | 1 real, verifiable testnet transaction hash, over-cap or wrong-counterparty withdrawal rejected by `__check_auth` |
| Zero core-pipeline changes | `packages/core`, `packages/recorder`, `packages/synthesizer`, `packages/harness`, `packages/sdk` require no modification — only new fixture + new example scripts (validates §6.3's generality claim; if false, document why) |
| Documentation honesty | README explicitly states testnet-only status and "no anchor has adopted this pattern" disclaimer |

---

## 12. Team and timeline

Given the existing pipeline needs no changes, this is estimated as a small, single-contributor addition rather than a multi-role effort:

| Phase | Effort (order of magnitude) |
|---|---|
| Phase 1 (fixture + offline example) | 2–4 days, comparable to the effort implied by `blend-yield-claim`'s own scope |
| Phase 2 (testnet wiring + hashes) | 1–2 days, directly analogous to `plan.md` Workstream 1–2, which already did this once for the Blend flow |
| Phase 3 (ecosystem conversation) | Unscheduled, contingent on Phase 1–2 completion and unrelated business development effort |

This should not be scheduled ahead of, or in competition with, any currently-active band-uplift or tranche work already committed in `plan.md` or `RFP-MAPPING.md` — it is additive, lower-priority evidence, not a gate-critical deliverable.

---

## 13. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| The mock-anchor's call shape turns out to need synthesizer changes, undercutting the "zero core changes" generality claim | Low–Medium | Treat as a valid finding either way — document what changed and why; a synthesizer that needs light extension to handle a new call shape is still a smaller finding than "the whole approach doesn't generalize" |
| The example reads as more anchor-integration than it is, misleading a reviewer into thinking warden talks to real anchors | Medium | Explicit disclaimers in README and this PRD; name the mock contract unambiguously (`mock-anchor`, not e.g. `soneso-anchor`); never reference a real anchor's home domain or signing key |
| Effort spent here competes with gate-critical band-uplift work | Medium | Explicitly sequence this behind any active band gate (per `plan.md`'s own stated principle that splitting effort across priorities costs both) |
| No anchor or maintainer ever responds to Phase 3 outreach | High | Phase 3 is explicitly optional and non-blocking; Phases 1–2 stand alone as valid RFP evidence regardless of Phase 3's outcome |
| A reviewer discounts a second *self-authored* example as not real independent validation | Medium | Frame the motivation honestly in the README: sourced from documented gaps in a real, named, third-party crate (`stellar-agent-anchor`), not invented in a vacuum |

---

## 14. Open questions

1. Should the mock-anchor's `withdraw` call shape (arguments, memo handling) attempt to mirror what a *real* future Soroban-native anchor settlement path might look like, or stay maximally generic to keep the "zero core-pipeline changes" claim clean? This document defaults to maximally generic; a future author could reasonably choose otherwise.
2. Is a weekly rolling cap (matching the Blend example's payroll cap) the right default generalization for a withdrawal policy, or should the first version force a per-call-only cap to keep the deny-matrix simpler? Left to whoever demos the flow, per warden's own "advisor surfaces the question, human decides" model.
3. Would `stellar-agent-anchor`'s actual maintainers (Soneso) have any interest in this pattern, or would they consider bounded-signer authority orthogonal to their scoping decision (i.e., they stopped at discovery for reasons unrelated to authority-scoping, such as pure regulatory non-negotiability regardless of on-chain guarantees)? Unknown — this is the central open question Phase 3 exists to answer, and "not interested, for reasons X" is a legitimate possible outcome.
4. Should this example ship before or after the OZ smart-accounts codegen backend (existing tranche work)? This document takes no position; it is written to be addable independent of that work's sequencing.

---

## 15. Verified technical facts this PRD depends on

| Fact | Status |
|---|---|
| `stellar-agent-anchor` (Soneso, v0.1.0-alpha.6, Apache-2.0, published 2026-08-12, ~81 downloads) exposes exactly two MCP tools (`stellar_sep6_deposit_info`, `stellar_sep24_interactive_url`) and explicitly does not call deposit/withdraw/deposit-exchange/withdraw-exchange/customer(SEP-12)/fee/transaction(s) endpoints, transmit SEP-9 KYC fields, or auto-follow the SEP-24 interactive URL | VERIFIED (docs.rs, crates.io, GitHub; 2-1 and 3-0 adversarial votes) |
| `stellar-agent-wallet` (Soneso) documents rolling-window spend limits and an External-Ed25519 signer enforcing execute calls within on-chain limits; its README describes no fiat/off-ramp capability | VERIFIED (2-1 vote) |
| `stellar-agent-guard-contracts` implements `__check_auth`-gated policy enforcement via admin-set `PolicyConfig`, not demonstration-synthesized policy | VERIFIED (0-3 refuted as direct prior-art match for warden's synthesis mechanism) |
| ERC-7715 (`wallet_requestExecutionPermissions`) and ZeroDev's permissions system provide real, adopted scoped/revocable smart-account authority on Ethereum, but compose policy from pre-defined primitive types rather than synthesizing from a recorded demonstration | VERIFIED |
| warden's existing pipeline (`packages/core`, `recorder`, `synthesizer`, `harness`, `sdk`), `contracts/smart-account-lite`, and the `blend-yield-claim` example's live-testnet loop (owner-signed `add_signer` install, permit tx, deny tx rejected by `__check_auth` with `CapExceeded`) | READ (this repository, `README.md`, `docs/ARCHITECTURE.md`, `examples/blend-yield-claim/README.md`, `plan.md`) |
| No project, on Stellar or in the Ethereum account-abstraction ecosystem, was found that synthesizes a minimal authorization policy from a recorded demonstration and proves it with generated differential tests | VERIFIED (high confidence, cross-referenced against Soneso's two projects, `stellar-agent-guard-contracts`, ERC-7715, and ZeroDev) |
