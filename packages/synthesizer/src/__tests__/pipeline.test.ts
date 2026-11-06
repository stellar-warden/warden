import { describe, expect, it } from "vitest";
import { explainPolicy } from "@stellar-warden/core";
import { HeuristicAdvisor, ModelAdvisor } from "../advisor.js";
import { generateCrate } from "../codegen.js";
import { generateCases } from "../denygen.js";
import { evalInvocation, newState } from "../eval.js";
import { inferPolicy } from "../infer.js";
import { ACCOUNT, ALICE, BOB, SIGNER, USDC, payrollRecording } from "./fixtures.js";

describe("infer", () => {
  it("derives least-authority defaults from a recording", () => {
    const { spec, questions } = inferPolicy(payrollRecording(), SIGNER);

    expect(spec.rules).toHaveLength(2);
    const transfer = spec.rules.find((r) => r.function === "transfer");
    expect(transfer).toBeDefined();
    expect(transfer!.argCount).toBe(3);

    const dest = transfer!.args.find((a) => a.argIndex === 1);
    expect(dest?.kind).toBe("anyOf");
    if (dest?.kind === "anyOf") {
      expect(dest.values.map((v) => v.value).sort()).toEqual([ALICE, BOB].sort());
    }

    const amount = transfer!.args.find((a) => a.argIndex === 2);
    expect(amount?.kind).toBe("cappedSum");
    if (amount?.kind === "cappedSum") {
      expect(amount.cap).toBe("2400000000"); // SUM observed: flow replayable once per window
      expect(amount.window).toBe("week");
    }

    // amount generalization must be surfaced as a question, never silent
    expect(questions.some((q) => q.appliedDefault.includes("cappedSum"))).toBe(true);
    expect(spec.denyUnmatched).toBe(true);
  });

  it("explains itself deterministically", () => {
    const { spec } = inferPolicy(payrollRecording(), SIGNER);
    const text = explainPolicy(spec);
    expect(text).toContain("DENIED");
    expect(text).toContain("transfer");
  });
});

describe("differential: denygen expectations match the reference evaluator", () => {
  it("every generated case evaluates to its declared expectation", () => {
    const recording = payrollRecording();
    const { spec } = inferPolicy(recording, SIGNER);
    const cases = generateCases(recording, spec);

    expect(cases.filter((c) => c.expect === "permit").length).toBeGreaterThanOrEqual(3);
    expect(cases.filter((c) => c.expect === "deny").length).toBeGreaterThanOrEqual(6);

    for (const c of cases) {
      // fresh state per case: window accumulation is tested separately
      const verdict = evalInvocation(spec, c.invocation, newState(1_000_000));
      expect(verdict.ok, `${c.name} (${c.reason}) → ${verdict.ok ? "permit" : (verdict as { reason: string }).reason}`).toBe(
        c.expect === "permit",
      );
    }
  });

  it("rolling cap accumulates across calls and denies the overflow", () => {
    const recording = payrollRecording();
    const { spec } = inferPolicy(recording, SIGNER);
    const state = newState(1_000_000);
    const pay = (amount: string) =>
      evalInvocation(
        spec,
        {
          contract: USDC,
          function: "transfer",
          args: [
            { kind: "address", value: ACCOUNT },
            { kind: "address", value: ALICE },
            { kind: "i128", value: amount },
          ],
          subInvocations: [],
        },
        state,
      );
    expect(pay("1500000000").ok).toBe(true);
    expect(pay("900000000").ok).toBe(true); // exactly at cap 2_400_000_000 (the recorded flow)
    const third = pay("1");
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toContain("cap exceeded");
  });
});

describe("codegen", () => {
  it("emits a deny-by-default crate whose tests mirror the case matrix", () => {
    const recording = payrollRecording();
    const { spec } = inferPolicy(recording, SIGNER);
    const crate = generateCrate(spec, recording);

    const lib = crate.files["src/lib.rs"]!;
    expect(lib).toContain("#![no_std]");
    expect(lib).toContain('Err(symbol_short!("norule"))'); // structural deny-by-default
    expect(lib).toContain("add_checked"); // rolling cap wired to counters
    expect(lib).toContain("if amt < 0"); // negative amounts rejected

    const tests = crate.files["tests/permit_deny.rs"]!;
    for (const c of crate.cases) expect(tests).toContain(`fn ${c.name}()`);
    expect(tests).toContain("window_accumulates"); // sequence test generated (2×1500 > cap)
    expect(tests).toContain("window_resets");

    const cargo = crate.files["Cargo.toml"]!;
    expect(cargo).toContain("[workspace]"); // detached from parent workspace
    expect(crate.files["POLICY.md"]).toContain("Verification matrix");
    expect(crate.skipped).toHaveLength(0);
  });

  it("is deterministic", () => {
    const recording = payrollRecording();
    const { spec } = inferPolicy(recording, SIGNER);
    const a = generateCrate(spec, recording);
    const b = generateCrate(spec, recording);
    expect(a.files).toEqual(b.files);
  });
});

describe("advisor", () => {
  it("heuristic advisor passes the draft through with no warnings", async () => {
    const recording = payrollRecording();
    const { spec } = inferPolicy(recording, SIGNER);
    const out = await new HeuristicAdvisor().refine(spec, recording);
    expect(out.source).toBe("heuristic");
    expect(out.warnings).toHaveLength(0);
  });

  it("repairs invalid model output, accepts a valid refinement, and enforces invariants", async () => {
    const recording = payrollRecording();
    const { spec } = inferPolicy(recording, SIGNER);

    const tightened = structuredClone(spec) as typeof spec;
    for (const r of tightened.rules)
      for (const a of r.args) if (a.kind === "cappedSum") a.window = "month"; // real refinement, flow still replayable

    const replies = ["not json at all", JSON.stringify({ version: 1 }), JSON.stringify(tightened)];
    let i = 0;
    const advisor = new ModelAdvisor(async () => replies[i++]!);
    const out = await advisor.refine(spec, recording, "monthly payroll, cap around 200 USDC");
    expect(out.source).toBe("model");
    expect(out.attempts).toBe(3);
    expect(out.warnings).toHaveLength(0);

    // a proposal that adds a new call target must be rejected → falls back to heuristic
    const widened = structuredClone(spec) as typeof spec;
    widened.rules.push({ ...widened.rules[0]!, id: "sneaky_1", function: "burn" });
    const evil = new ModelAdvisor(async () => JSON.stringify(widened), 1);
    const out2 = await evil.refine(spec, recording);
    expect(out2.source).toBe("heuristic");
  });

  it("warns when a refinement would deny the recorded flow", async () => {
    const recording = payrollRecording();
    const { spec } = inferPolicy(recording, SIGNER);
    const narrowed = structuredClone(spec) as typeof spec;
    for (const r of narrowed.rules)
      for (const a of r.args) if (a.kind === "cappedSum") a.cap = "1"; // below recorded amounts
    const advisor = new ModelAdvisor(async () => JSON.stringify(narrowed), 1);
    const out = await advisor.refine(spec, recording);
    expect(out.source).toBe("model");
    expect(out.warnings.length).toBeGreaterThan(0);
    expect(out.warnings[0]).toContain("DENIED");
  });
});
