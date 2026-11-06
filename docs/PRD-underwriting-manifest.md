# PRD — Risk Manifest Export (Warden Tranche Extension)

**Working name:** warden risk manifest (`@stellar-warden/manifest`)
**Version:** 0.1 (proposal) · 2026-09-16
**Status:** Roadmap extension, not committed tranche work. Gated by Phase 0 below — do not start Phase 1 build until the kill criterion in §2.3 is checked.
**Relationship to warden core:** additive only. This document proposes a new, optional export surface on top of the existing `PolicySpec` pipeline described in `docs/ARCHITECTURE.md`. It does not modify `packages/core`, `packages/synthesizer`, `packages/harness`, `contracts/policy-core`, or `contracts/smart-account-lite`, and it does not change warden's trust model (see §6.4).
**Evidence labels:** VERIFIED (fetched primary source or read directly from this repo, 2026-09-16) · REASONED · ASSUMPTION · PROPOSED (this document's own design, not evidence of anything built or agreed).

---

## 1. One-paragraph summary

Warden already produces something no Stellar lending protocol currently consumes: a policy whose worst-case behavior is not a promise but a proof. A synthesized `PolicySpec` — deny-by-default, rolling-counter caps, argument-level constraints — is checked twice (a TS reference evaluator and generated Rust under real `soroban-sdk`) and then enforced on-chain by the account's own `__check_auth`, not by the borrower's good behavior. Meanwhile, Stellar's flagship lending market, Blend, sizes every borrow limit purely from posted collateral value, with no term for identity, history, or behavioral guarantee (VERIFIED, §2.3). This document proposes `@stellar-warden/manifest`: a small, additive export that turns an already-installed, already-proven policy into a signed, machine-readable "risk manifest" — a hard ceiling a lending protocol could read and price against, instead of the fixed collateral-factor formula it uses today. This is not a lending product. It is an export format plus a reference/mock consumer, built to find out whether any real lending protocol would use it before anyone builds the lending side.

---

## 2. Problem and evidence

### 2.1 Pain statement

> **A Soroban lending protocol pricing risk for an AI-agent-controlled account** has exactly one lever today: how much collateral is posted. It has no way to observe, let alone price, the fact that the borrower's *key itself* may be incapable of doing anything but a narrow, audited, on-chain-enforced set of actions — a materially different risk profile than a general-purpose EOA or a smart account with unrestricted signers. There is no artifact today that expresses "this account's outflow is capped at X per week, provably, by code the protocol invoking `__check_auth` cannot bypass."

> **A policy-scoped agent wallet operator** (e.g., a warden user running a payroll or yield-claim agent per `examples/blend-yield-claim`) has already paid the cost of least-authority design — a synthesized, tested, on-chain-enforced cap — but has no way to make that cost legible to anyone outside their own dashboard. The proof exists; there is no channel to surface it as a credential.

### 2.2 Why this is worth 0.1 of a tranche, not more, right now

| Signal | Status | Source |
|---|---|---|
| Blend borrow limit is a pure collateral formula, no reputation/identity/behavioral term | VERIFIED | `docs.blend.capital/users/lending-borrowing/borrowing`: `BorrowLimit = Σ(CollateralFactor × CollateralValue)` |
| No confirmed cross-chain precedent for mapping an on-chain reputation/behavior signal directly into a borrowing limit | VERIFIED (absence) | A claim that RociFi (Polygon) does this via an on-chain "Non-Fungible Credit Score" was checked twice by independent adversarial review and refuted both times (votes 1-2, then 0-3) against `github.com/RociFi/Roci-Smart-Contracts-v2`. No other candidate survived verification. |
| No lending protocol — on Stellar or elsewhere — has agreed to consume anything resembling this manifest | VERIFIED (absence, this is a proposal only) | No such agreement exists; this is the central risk, see §2.3 and §9 |
| Stellar 8004's "WAD" reputation score (referenced in the original research brief as a candidate underwriting input) is a third-party-attestation registry, not a cryptographic proof of anything | VERIFIED | `developers.stellar.org/meetings/2026/04/23`: Stellar 8004 is three Soroban contracts (identity, reputation, Validation) where "third-party organizations can endorse agents through on-chain attestations" — a trust-shifting mechanism, structurally different from what this proposal exports (a deterministic, test-proven bound, not an attestation) |

Reading across these: the absence of precedent cuts both ways. It means this would be genuinely novel — not a catch-up play against RociFi or anyone else — but it also means there is **zero market validation** that a lender would trust a code-enforced cap over collateral. That uncertainty is the whole reason this is scoped as an export-and-see, not a lending product.

### 2.3 What exists, and why it is not this

| Project | What it does | Gap relative to this proposal |
|---|---|---|
| Blend Capital | Soroban lending/borrowing markets | Borrow limit is `Σ(CollateralFactor × CollateralValue)` only (VERIFIED, primary docs). No hook for any external risk signal, reputation, or behavioral bound. Adding one is out of warden's control — this proposal can only make the signal available, not make Blend (or anyone) consume it. |
| Stellar 8004 (identity/reputation/Validation registries) | On-chain agent identity + third-party attestation | Solves a different problem (who vouches for an agent's *behavior/history*), not "what is this account's key mathematically incapable of doing." Complementary, not competing: a lender could in principle want both a reputation attestation *and* a provable spend ceiling. This proposal only produces the latter. |
| RociFi (Polygon, cross-chain) | Reputation-scored under-collateralized lending via an ERC-721 "Non-Fungible Credit Score" | Checked as potential prior art and refuted (votes 1-2, 0-3 against the specific claim that it constitutes a working precedent) — it is a *credit-history*-based score, not a *code-enforced-ceiling*-based one, and its status as a live, adopted system was not established by verified evidence. Not usable as a template to copy; noted here only so this PRD isn't rediscovering something that already works elsewhere. |
| warden core (this repo) | Synthesizes and proves the policy itself | Produces the underlying fact (a proven cap) but has no export format today. `PolicySpec` (packages/core) is internal IR; nothing in the current pipeline serializes a subset of it for consumption by a third party outside the warden pipeline. This is the gap this PRD closes — narrowly. |

---

## 3. Goals and non-goals

**Goals**
1. Define a minimal, signed, machine-readable manifest format that losslessly represents the *hard bounds* of an installed `PolicySpec` (max per-tx, rolling-window cap, allowed counterparty contracts/functions) without exposing anything else about the account.
2. Ship an export command/tool that produces this manifest from an already-installed policy, with no new trust assumptions beyond what warden already has.
3. Ship one reference/mock consumer (not a real lending integration) that demonstrates a plausible use: given a manifest, compute a hypothetical reduced-collateral borrowing suggestion, purely illustrative.
4. Use the above as a concrete artifact to test, cheaply, whether any real Soroban lending protocol has interest — before committing further engineering.

**Non-goals**
- Building a lending protocol, an oracle, or a credit-scoring system. This proposal exports a fact; it does not lend money.
- Making any claim about creditworthiness, identity, or behavioral history. The manifest says only what the policy's code permits at maximum, never what the agent has actually done or is trustworthy of doing beyond that.
- Changing warden's trust model. Per `docs/ARCHITECTURE.md`, warden "never signs, never holds keys" and the model "never holds authority." The manifest export must not introduce any new signing authority, custody, or decision-making power for warden itself — see §6.4.
- Integrating with Stellar 8004 or any reputation/attestation system. That is a separate, unverified-status project (§2.3) and pulling it in would import its trust-shifting problem into what is otherwise a purely deterministic export. If a future tranche wants to combine the two, that is a distinct proposal.
- Any mainnet deployment or real-money lending pilot before Phase 0's kill criterion (§2.3, §9) is met.

---

## 4. Users and jobs to be done

| Persona | Job | Today | Interest in this (ASSUMPTION, unvalidated) |
|---|---|---|---|
| Warden user running a policy-scoped agent account (e.g., a payroll/yield-claim operator per `examples/blend-yield-claim`) | "Prove to a lender that my agent's key literally cannot move more than X/week, so I don't have to over-collateralize" | Has the proof (installed policy + passing differential tests) but no way to present it outside a warden-native context | High if any lender listens; the marginal cost to the user is near zero (an export command, not new infrastructure) |
| A Soroban lending protocol (Blend or a successor) evaluating whether to offer a reduced collateral factor for policy-scoped accounts | "Reduce my collateral requirement for a borrower whose downside is provably capped, without adding attestation/oracle risk" | No signal exists today (§2.3) | Unknown — this is exactly what Phase 0 tests, not something this PRD can assume |
| An auditor or grant reviewer (SCF, OZ) evaluating warden's OZ Accounts Policy Builder RFP submission | "See a concrete, additive use case for the synthesized PolicySpec beyond the account itself" | RFP-MAPPING.md already documents the core deliverables; this would be an appendix showing composability | Directly relevant to "why this team" framing in RFP-MAPPING.md §Evaluation-criteria alignment |

---

## 5. Product scope by phase

### Phase 0 — Demand check (weeks 0–2, before any code)

**Work:** Show the manifest concept (a one-page mock JSON example + a one-paragraph pitch) to whoever is reachable from the Blend team or another live Soroban lending project, and separately to the OZ RFP reviewers as a roadmap idea. This costs nothing beyond conversation time.

**Kill criterion (stop here if true):** No lending protocol maintainer, when shown a concrete manifest example, expresses even conditional interest in a future integration (e.g., "if this existed we'd consider a pilot"). Silence, indifference, or "we'd need our own credit model regardless" all count as kill signals.

**Exit:** At least one lending-protocol contact who will look at a working export when it exists, OR explicit reviewer interest in the idea as RFP-appendix material even without a lending partner (i.e., the idea has standalone documentation value even if unused). If neither, do not proceed to Phase 1 — leave this document as a recorded idea and move on.

### Phase 1 — Manifest format + export tool + mock consumer (weeks 2–5, gated by Phase 0)

**Deliverables**
- `packages/manifest` (new, additive package): a pure function `exportManifest(spec: PolicySpec, accountId: string): RiskManifest` that reads an already-synthesized `PolicySpec` (no new inference, no new LLM step) and projects it into the manifest schema (§7). Deterministic; no network calls.
- `warden manifest export` CLI subcommand (extends `packages/cli`, same pattern as existing `record|propose|explain|synth|test|install`) and an MCP tool `export_manifest` (extends `packages/mcp-server`, same unsigned-output convention as `build_install_tx`).
- Signing: the manifest is signed by the **account owner's key**, off-band, the same way `add_signer` XDR is signed today — warden produces the unsigned manifest payload; the owner (or their existing signing flow) attaches a signature. Warden itself never holds or uses a signing key for this, consistent with §6.4.
- A reference/mock consumer script (`examples/manifest-consumer` — offline, no real lending protocol involved) that ingests a signed manifest and prints an illustrative "suggested reduced collateral factor" using a simple, clearly-labeled toy formula. This exists only to make the concept concrete for a demo or a reviewer, not as a real risk model.

**Acceptance:** `warden manifest export --account <smart-account-lite-instance>` produces a manifest matching §7's schema for the existing `examples/blend-yield-claim` policy; the mock consumer accepts it and prints a plausible illustrative output; `cargo test`/`pnpm test` unaffected (this package has no dependency from `core`/`synthesizer`/`harness` back onto it).

### Phase 2 — Real pilot (contingent, not before Phase 1 ships and a lending partner exists)

Not specified in detail here — this is explicitly out of scope until Phase 0's kill criterion is re-checked with a working artifact in hand. If a lending protocol wants to consume the manifest for real, that becomes its own PRD (their integration, their risk model, their liability) rather than an extension of this one.

---

## 6. Architecture

### 6.1 System diagram (textual)

```
 existing warden pipeline (unchanged)                new, additive
┌─────────────────────────────────────┐    ┌──────────────────────────────┐
│ record → synthesize → prove →        │    │ @stellar-warden/manifest              │
│ install (packages/core, synthesizer, │───▶│ exportManifest(spec, account) │
│ harness, sdk — see ARCHITECTURE.md)  │    │ pure projection, no inference │
└─────────────────────────────────────┘    └───────────────┬───────────────┘
                                                            │ unsigned RiskManifest JSON
                                                            ▼
                                            ┌──────────────────────────────┐
                                            │ owner signs off-band          │
                                            │ (same convention as           │
                                            │  add_signer XDR today)        │
                                            └───────────────┬───────────────┘
                                                            │ signed manifest
                                                            ▼
                                            ┌──────────────────────────────┐
                                            │ examples/manifest-consumer    │
                                            │ (offline mock — Phase 1)      │
                                            │ OR a real lending protocol    │
                                            │ (Phase 2, contingent, out of  │
                                            │  scope here)                  │
                                            └──────────────────────────────┘
```

### 6.2 Components

| Component | Responsibility | New/existing |
|---|---|---|
| `packages/manifest` | `PolicySpec` → `RiskManifest` projection; pure, deterministic, no I/O beyond reading the spec | New (additive package, no changes to existing packages) |
| `packages/cli` `manifest export` subcommand | Headless invocation | New subcommand on existing package |
| `packages/mcp-server` `export_manifest` tool | Conversational invocation, same unsigned-output convention as `build_install_tx` | New tool on existing package |
| `examples/manifest-consumer` | Illustrative, offline mock consumer | New example, same layout convention as `examples/blend-yield-claim` |

### 6.3 Key technical decisions

1. **Projection, not re-inference.** The manifest is derived only from an already-synthesized, already-tested `PolicySpec` — it adds no new judgment, no new LLM step, and no new attack surface on the advisor loop described in `docs/ARCHITECTURE.md`. If the spec changes, the manifest must be re-exported; there is no live sync (PROPOSED — see §8 for staleness handling).
2. **Owner signs, warden doesn't.** Consistent with the existing trust-model table in `docs/ARCHITECTURE.md` ("owner key: root authority... session key: act within installed rules... NOT trusted to: hold keys"), the manifest-signing step reuses the owner's existing off-band signature flow. `@stellar-warden/manifest` itself has no keys and cannot sign anything.
3. **No new on-chain component.** The manifest is an off-chain artifact (signed JSON), not a new Soroban contract. A consumer that wants an on-chain guarantee should read the account's installed policy state directly (already possible today via `smart-account-lite` and `contracts/policy-core`, per `docs/ARCHITECTURE.md`); the manifest is a convenience/discovery layer, not the source of truth. The source of truth remains `__check_auth`.
4. **Staleness is the consumer's problem to price, not warden's to solve here.** A manifest is a snapshot. If the owner later installs a wider policy, an old manifest becomes stale. Phase 1 addresses this only by including an `exportedAt` timestamp and the on-chain policy's storage key so a diligent consumer can re-verify against chain state before relying on it (§7); a push/webhook staleness-invalidation mechanism is explicitly deferred (§10 open questions), not solved by this phase.

### 6.4 Trust-model conformance (must-hold invariant)

This table is a restatement of `docs/ARCHITECTURE.md`'s existing trust model, with the new component's authority level made explicit. No row for `@stellar-warden/manifest` should ever read anything other than "propose/export," matching the existing "model" and "synthesizer" rows:

| component | trusted to | NOT trusted to |
|---|---|---|
| `@stellar-warden/manifest` (new) | project an already-proven `PolicySpec` into a signed export format | infer policy content, hold keys, sign anything, decide what a lender should do with the export |
| owner key (existing) | root authority; now also signs the manifest, same as it signs `add_signer` | — |
| lending-protocol consumer (external, not part of warden) | read the manifest, decide its own risk pricing | rely on the manifest as a substitute for verifying live on-chain state, per §6.3.4 |

If any future implementation of this proposal requires `@stellar-warden/manifest` to hold a key, call a lending contract, or make a credit decision, that implementation has violated this PRD's scope and should be rejected at review.

---

## 7. Manifest schema (v0, PROPOSED)

```json
{
  "schemaVersion": "warden-risk-manifest/0",
  "account": "C...",                      // the smart-account-lite (or OZ smart-account, once T1 lands) instance id
  "network": "testnet",                   // matches WARDEN_NETWORK_PASSPHRASE convention
  "policyHash": "sha256:...",             // hash of the installed PolicySpec, for on-chain cross-check
  "exportedAt": "2026-09-16T00:00:00Z",
  "bounds": [
    {
      "counterparty": "C...",             // allowed contract address, from the recording (never invented — same non-invention principle as denygen, per ARCHITECTURE.md §"Deny cases mutate only along axes that are safe to construct")
      "function": "claim",
      "maxPerTx": "1500000000",           // stroops, matches PolicySpec argument constraints
      "rollingWindow": { "cap": "5000000000", "periodSeconds": 604800 }  // matches contracts/policy-core rolling-counter semantics
    }
  ],
  "denyUnmatched": true,                  // mirrors PolicySpec's denyUnmatched: z.literal(true) invariant — always true by construction, included for consumer clarity
  "ownerSignature": "ed25519:...",        // signed by the account owner's key, off-band — warden does not sign
  "provenance": {
    "generatedBy": "@stellar-warden/manifest v0.1",
    "sourcePolicySpecVersion": "..."
  }
}
```

Every field above traces to a concept already present in the real pipeline (`PolicySpec`'s `denyUnmatched` literal, `contracts/policy-core`'s rolling counters, the deny-case generator's "never invent addresses" rule) — this schema adds no new semantic warden doesn't already enforce; it only serializes a subset for external reading.

---

## 8. Export tool specification (v0)

`warden manifest export --account <C-address> [--network testnet|pubnet] --out manifest.json`

- Reads the account's currently-installed policy (via the same RPC path `packages/recorder` already uses to read chain state — no new RPC surface).
- Fails loudly (non-zero exit, no partial output) if the on-chain policy cannot be resolved or does not match a locally-known `PolicySpec` — this tool must never fabricate a manifest for a policy it cannot verify.
- Prints the unsigned manifest JSON; the owner signs it with their existing key management (out of scope for this tool, same posture as `build_install_tx`'s unsigned XDR).

MCP equivalent: `export_manifest(account, network)` → returns the same unsigned JSON, following the existing `record_flow`/`propose_policy`/... tool conventions in `packages/mcp-server`.

---

## 9. Positioning within the RFP roadmap

This is explicitly **not** part of the T0–T3 tranche sketch in `docs/RFP-MAPPING.md` and must not be presented as core OZ Accounts Policy Builder deliverable work. It belongs, if anywhere, as a short "future extensions" appendix to RFP-MAPPING.md, framed exactly as it is here: an idea with a demand-check gate, not a commitment. Per `plan.md`'s own stated lesson ("splitting the window between bands is how projects end a wave with neither"), this must never be scheduled inside a live band-uplift sprint (the pattern already established for OZ codegen backend, wallet UX, and Claude Skill packaging in `plan.md`'s "Explicitly NOT in scope before entry" list). Its only near-term value is as one paragraph of RFP narrative ("the proven-policy artifact composes beyond the account itself") plus, if Phase 0 finds interest, a small Phase 1 build in a tranche that has room, not a dedicated wave.

---

## 10. Risks, mitigations, and open questions

| Risk | Likelihood | Mitigation |
|---|---|---|
| No lending protocol has any interest (this is the central risk, see §2.2) | High (no evidence exists either way — this is genuinely unknown, not pessimism) | Phase 0 gate is mandatory and cheap; do not build Phase 1 without it clearing |
| Manifest goes stale (policy changes after export) and a consumer relies on it anyway | Medium | `policyHash` + `exportedAt` let a diligent consumer re-verify against chain state (§6.3.4); Phase 1 does not attempt push invalidation — flagged as an open question below |
| Scope creep into building an actual credit model or lending integration inside warden | Medium (this is an easy trap given the "novel, unsolved" framing) | Non-goals (§3) are explicit; `examples/manifest-consumer` must stay clearly labeled illustrative/mock, never presented as a real risk model |
| Reviewers read this as warden overreaching beyond its narrow, defensible niche (bounded authority for agent wallets) | Medium | Keep this document an appendix, never the centerpiece; see §9 |
| A manifest's "provable ceiling" is mistaken for a guarantee against smart-contract bugs in `policy-core` or `smart-account-lite` themselves | Low but high-impact if it happens | Manifest must not claim more than "this is what the audited/tested policy code permits"; it inherits, not exceeds, whatever assurance the underlying contracts already have (no additional audit claim implied) |

**Open questions**
1. Does any Soroban lending protocol (Blend or a successor) want to be shown a mock manifest at all? (Phase 0's entire purpose.)
2. Should the manifest be pushed (webhook on policy change) or pull-only (§6.3.4)? Deferred until there's a real consumer to design against.
3. Should `policyHash` cover the full `PolicySpec` or only the bounds relevant to lending (to reduce re-export churn from unrelated policy changes)? Undecided — Phase 1 can start with "full spec hash" and narrow later if a real consumer asks.
4. Is there any interaction with Stellar 8004 worth exploring later (e.g., a lender wanting both a behavioral attestation and a provable ceiling)? Noted as a possible future direction, explicitly not scoped here (§3).

---

## 11. Verified facts this PRD depends on

| Fact | Status |
|---|---|
| Blend's borrow limit formula is `BorrowLimit = Σ(CollateralFactor × CollateralValue)`, with no reputation/credit/identity term | VERIFIED — `docs.blend.capital/users/lending-borrowing/borrowing`, verified 3-0 |
| A claim that RociFi (Polygon) provides a working cross-chain precedent for reputation-based under-collateralized lending was checked twice and refuted twice (1-2, then 0-3) | VERIFIED (as an absence finding) — `github.com/RociFi/Roci-Smart-Contracts-v2` |
| Stellar 8004 is a third-party-attestation reputation registry (identity + reputation + Validation Soroban contracts), not a cryptographic correctness proof | VERIFIED — `developers.stellar.org/meetings/2026/04/23` |
| Warden's `PolicySpec` is deny-by-default by construction (`denyUnmatched: z.literal(true)`), proven by a dual TS-evaluator/generated-Rust differential test suite, and enforced on-chain via `__check_auth`; warden "never signs, never holds keys" and the model "never holds authority" | VERIFIED — read directly from `docs/ARCHITECTURE.md` and `README.md` in this repo, 2026-09-16 |
| Warden's rolling-counter and argument-constraint primitives live in `contracts/policy-core`; the deny-case generator never invents addresses, only draws from ones already in the recording | VERIFIED — read directly from `docs/ARCHITECTURE.md`, 2026-09-16 |
| Warden's current RFP tranche plan (T0–T3) and its "explicitly not in scope before entry" list do not include anything resembling this manifest | VERIFIED — read directly from `docs/RFP-MAPPING.md` and `plan.md`, 2026-09-16 |
