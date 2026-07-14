import type { Invocation, PolicySpec, RecordedEntry, Rule, ScValue } from "@warden/core";
import { flattenInvocations } from "@warden/core";

/**
 * Reference evaluator for PolicySpec semantics, in TypeScript.
 *
 * This is NOT the enforcement path — the generated Rust inside __check_auth is.
 * It exists so that (a) the pipeline is unit-testable without a Rust toolchain,
 * (b) the advisor can warn when a refinement would deny the recorded flow, and
 * (c) the Rust harness and this evaluator can be differentially tested against
 * the same fixtures (any divergence is a codegen bug).
 */

export type Verdict = { ok: true } | { ok: false; reason: string };

export interface EvalState {
  /** counters keyed by `${ruleId}:${argIndex}` → { windowStart, spent } */
  counters: Map<string, { windowStart: number; spent: bigint }>;
  nowSeconds: number;
}

export function newState(nowSeconds = 0): EvalState {
  return { counters: new Map(), nowSeconds };
}

const WINDOW_SECONDS: Record<string, number> = {
  "per-call": 0,
  hour: 3600,
  day: 86400,
  week: 604800,
  month: 2592000,
};

export function evalInvocation(spec: PolicySpec, inv: Invocation, state: EvalState): Verdict {
  const rule = spec.rules.find((r) => r.contract === inv.contract && r.function === inv.function);
  if (!rule) return deny(`no rule matches ${inv.contract.slice(0, 4)}…::${inv.function}`);
  if (inv.args.length !== rule.argCount)
    return deny(`arg count ${inv.args.length} ≠ expected ${rule.argCount} (rule ${rule.id})`);
  return evalArgs(rule, inv.args, state);
}

/** Evaluate a whole recorded entry: every invocation in the tree must pass. */
export function evalEntry(spec: PolicySpec, entry: RecordedEntry, state: EvalState): Verdict {
  for (const inv of flattenInvocations(entry)) {
    if (inv.function === "__create_contract__") return deny("contract creation is never permitted in v1");
    const v = evalInvocation(spec, inv, state);
    if (!v.ok) return v;
  }
  return { ok: true };
}

function evalArgs(rule: Rule, args: ScValue[], state: EvalState): Verdict {
  for (const c of rule.args) {
    const actual = args[c.argIndex];
    if (actual === undefined) return deny(`missing arg${c.argIndex} (rule ${rule.id})`);
    switch (c.kind) {
      case "any":
        break;
      case "exact":
        if (!valueEq(actual, c.value)) return deny(`arg${c.argIndex} ≠ required value (rule ${rule.id})`);
        break;
      case "anyOf":
        if (!c.values.some((v) => valueEq(actual, v)))
          return deny(`arg${c.argIndex} not in allowlist (rule ${rule.id})`);
        break;
      case "cappedSum": {
        if (actual.kind !== "i128") return deny(`arg${c.argIndex} is not i128 (rule ${rule.id})`);
        const amount = BigInt(actual.value);
        if (amount < 0n) return deny(`arg${c.argIndex} negative amount (rule ${rule.id})`);
        const cap = BigInt(c.cap);
        const key = `${rule.id}:${c.argIndex}`;
        const win = WINDOW_SECONDS[c.window] ?? 0;
        const cur = state.counters.get(key);
        let windowStart = cur?.windowStart ?? state.nowSeconds;
        let spent = cur?.spent ?? 0n;
        if (win === 0 || state.nowSeconds - windowStart >= win) {
          windowStart = state.nowSeconds;
          spent = 0n;
        }
        if (spent + amount > cap)
          return deny(`arg${c.argIndex} cap exceeded: ${spent}+${amount} > ${cap} per ${c.window} (rule ${rule.id})`);
        state.counters.set(key, { windowStart, spent: spent + amount });
        break;
      }
    }
  }
  return { ok: true };
}

export function valueEq(a: ScValue, b: ScValue): boolean {
  return a.kind === b.kind && String(a.value) === String(b.value);
}

function deny(reason: string): Verdict {
  return { ok: false, reason };
}
