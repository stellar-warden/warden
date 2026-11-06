import {
  flattenInvocations,
  parsePolicySpec,
  type ArgConstraint,
  type Invocation,
  type PolicySpec,
  type Recording,
  type Rule,
  type ScValue,
  type Signer,
} from "@stellar-warden/core";

export interface OpenQuestion {
  ruleId: string;
  argIndex: number;
  question: string;
  appliedDefault: string;
}

export interface InferResult {
  spec: PolicySpec;
  questions: OpenQuestion[];
}

/**
 * Deterministic generalization of a Recording into a draft PolicySpec.
 *
 * Defaults are deliberately conservative (least authority):
 *   - addresses      → allowlist of exactly the observed values
 *   - i128 amounts   → rolling cap = max observed, per week   (flagged as a question)
 *   - everything else→ exact match on the observed value(s)
 *   - opaque values  → `any` + a question (cannot be safely matched; must be refined)
 *
 * The advisor (LLM or human) may then adjust — but only through the schema.
 */
export function inferPolicy(recording: Recording, signer: Signer): InferResult {
  const questions: OpenQuestion[] = [];
  const groups = groupCallSites(recording);
  const rules: Rule[] = [];

  let n = 0;
  for (const g of groups.values()) {
    n += 1;
    const id = ruleId(g.function, n);
    const args: ArgConstraint[] = [];
    for (let i = 0; i < g.argCount; i++) {
      const observed = g.calls.map((c) => c.args[i]).filter((v): v is ScValue => v !== undefined);
      args.push(constraintFor(id, i, observed, questions));
    }
    rules.push({ id, contract: g.contract, function: g.function, args, argCount: g.argCount });
  }

  const spec = parsePolicySpec({
    version: 1,
    account: recording.account,
    signer,
    rules,
    denyUnmatched: true,
  });
  return { spec, questions };
}

interface CallGroup {
  contract: string;
  function: string;
  argCount: number;
  calls: Invocation[];
}

function groupCallSites(recording: Recording): Map<string, CallGroup> {
  const groups = new Map<string, CallGroup>();
  for (const entry of recording.entries) {
    for (const inv of flattenInvocations(entry)) {
      if (inv.function === "__create_contract__") continue; // out of scope for v1
      const key = `${inv.contract}::${inv.function}/${inv.args.length}`;
      const g = groups.get(key) ?? {
        contract: inv.contract,
        function: inv.function,
        argCount: inv.args.length,
        calls: [],
      };
      g.calls.push(inv);
      groups.set(key, g);
    }
  }
  return groups;
}

function constraintFor(
  ruleIdStr: string,
  argIndex: number,
  observed: ScValue[],
  questions: OpenQuestion[],
): ArgConstraint {
  const first = observed[0];
  if (!first) return { kind: "any", argIndex };

  if (observed.some((v) => v.kind === "opaque")) {
    questions.push({
      ruleId: ruleIdStr,
      argIndex,
      question: `arg${argIndex} has a type warden cannot yet match structurally; it is UNCONSTRAINED. Constrain the call another way or extend the type support.`,
      appliedDefault: "any",
    });
    return { kind: "any", argIndex };
  }

  if (first.kind === "address") {
    const values = dedupe(observed);
    return { kind: "anyOf", argIndex, values };
  }

  if (first.kind === "i128") {
    // Sum, not max: the recorded flow must be replayable within one window,
    // and the differential harness replays it as a sequence.
    const sum = observed.map((v) => BigInt(v.value as string)).reduce((a, b) => a + b, 0n);
    questions.push({
      ruleId: ruleIdStr,
      argIndex,
      question: `arg${argIndex} looks like an amount (${observed.length} call(s), total ${sum}). Fixed amount, or a cap? Default: rolling cap of ${sum} per week (whole flow, once per window).`,
      appliedDefault: `cappedSum ${sum}/week`,
    });
    return { kind: "cappedSum", argIndex, cap: sum.toString(), window: "week" };
  }

  const values = dedupe(observed);
  if (values.length === 1) return { kind: "exact", argIndex, value: values[0]! };
  return { kind: "anyOf", argIndex, values };
}

function dedupe(values: ScValue[]): ScValue[] {
  const seen = new Set<string>();
  const out: ScValue[] = [];
  for (const v of values) {
    const k = `${v.kind}:${String(v.value)}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}

function ruleId(fn: string, n: number): string {
  const base = fn.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32);
  return /^[a-z]/.test(base) ? `${base}_${n}` : `r_${base}_${n}`;
}
