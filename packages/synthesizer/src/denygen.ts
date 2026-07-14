import type { Invocation, PolicySpec, Recording, ScValue } from "@warden/core";
import { flattenInvocations } from "@warden/core";

/**
 * Deny-case generation — the half of verification that makes this a policy
 * builder rather than a code generator.
 *
 * Permit cases prove the policy allows the demonstrated flow.
 * Deny cases prove it allows NOTHING ELSE. Each mutation below targets one
 * escape hatch an attacker (or a confused agent) would try.
 *
 * Address mutations only ever reuse addresses that already appear in the
 * recording (or the governed account itself): strkeys are checksummed, so
 * inventing one would produce invalid test fixtures, not adversarial ones.
 */

export interface Case {
  name: string;
  invocation: Invocation;
  expect: "permit" | "deny";
  reason: string;
}

export function generateCases(recording: Recording, spec: PolicySpec): Case[] {
  const cases: Case[] = [];
  const invocations = recording.entries
    .flatMap(flattenInvocations)
    .filter((i) => i.function !== "__create_contract__");
  const addressPool = collectAddresses(recording);

  invocations.forEach((inv, i) => {
    cases.push({ name: `permit_${i + 1}_recorded`, invocation: inv, expect: "permit", reason: "recorded flow" });
  });

  const seen = new Set<string>();
  for (const inv of invocations) {
    const rule = spec.rules.find((r) => r.contract === inv.contract && r.function === inv.function);
    if (!rule || seen.has(rule.id)) continue;
    seen.add(rule.id);

    cases.push({
      name: `deny_${rule.id}_wrong_function`,
      invocation: { ...inv, function: mutateFunctionName(inv.function), subInvocations: [] },
      expect: "deny",
      reason: "same contract, unlisted function",
    });

    cases.push({
      name: `deny_${rule.id}_extra_arg`,
      invocation: { ...inv, args: [...inv.args, { kind: "u32", value: 0 }], subInvocations: [] },
      expect: "deny",
      reason: "argument count mismatch",
    });

    const foreignContract = addressPool.find((a) => a.startsWith("C") && a !== inv.contract);
    if (foreignContract) {
      cases.push({
        name: `deny_${rule.id}_wrong_contract`,
        invocation: { ...inv, contract: foreignContract, subInvocations: [] },
        expect: "deny",
        reason: "unlisted contract",
      });
    }

    for (const c of rule.args) {
      const idx = c.argIndex;
      const original = inv.args[idx];
      if (!original) continue;
      if (c.kind === "exact" || c.kind === "anyOf") {
        const mutated = mutateValue(original, addressPool, c.kind === "anyOf" ? c.values : [c.value]);
        if (mutated) {
          cases.push({
            name: `deny_${rule.id}_arg${idx}_out_of_set`,
            invocation: replaceArg(inv, idx, mutated),
            expect: "deny",
            reason: c.kind === "anyOf" ? "value outside allowlist" : "value differs from exact match",
          });
        }
      }
      if (c.kind === "cappedSum") {
        const over = (BigInt(c.cap) + 1n).toString();
        cases.push({
          name: `deny_${rule.id}_arg${idx}_over_cap`,
          invocation: replaceArg(inv, idx, { kind: "i128", value: over }),
          expect: "deny",
          reason: `single call exceeds cap ${c.cap}`,
        });
        cases.push({
          name: `deny_${rule.id}_arg${idx}_negative`,
          invocation: replaceArg(inv, idx, { kind: "i128", value: "-1" }),
          expect: "deny",
          reason: "negative amount must never pass a cap check",
        });
      }
    }
  }
  return cases;
}

function replaceArg(inv: Invocation, idx: number, v: ScValue): Invocation {
  const args = inv.args.slice();
  args[idx] = v;
  return { ...inv, args, subInvocations: [] };
}

function mutateFunctionName(fn: string): string {
  const base = fn.length >= 30 ? fn.slice(0, 28) : fn;
  return `${base}_x`;
}

/** Produce a same-kind value guaranteed different from everything in `excluded`, or null if impossible safely. */
function mutateValue(original: ScValue, addressPool: string[], excluded: ScValue[]): ScValue | null {
  const isExcluded = (v: ScValue) => excluded.some((e) => e.kind === v.kind && String(e.value) === String(v.value));
  switch (original.kind) {
    case "address": {
      const candidate = addressPool
        .map<ScValue>((a) => ({ kind: "address", value: a }))
        .find((v) => !isExcluded(v));
      return candidate ?? null;
    }
    case "i128":
    case "u64": {
      const v: ScValue = { kind: original.kind, value: (BigInt(original.value) + 1n).toString() };
      return isExcluded(v) ? { kind: original.kind, value: (BigInt(original.value) + 2n).toString() } : v;
    }
    case "u32": {
      const v: ScValue = { kind: "u32", value: original.value + 1 };
      return isExcluded(v) ? { kind: "u32", value: original.value + 2 } : v;
    }
    case "symbol": {
      const v: ScValue = { kind: "symbol", value: `${original.value.slice(0, 30)}_x` };
      return isExcluded(v) ? null : v;
    }
    case "string": {
      const v: ScValue = { kind: "string", value: `${original.value}_x` };
      return isExcluded(v) ? null : v;
    }
    case "bool": {
      const v: ScValue = { kind: "bool", value: !original.value };
      return isExcluded(v) ? null : v;
    }
    case "bytes": {
      const flipped = original.value.length >= 2 ? `${original.value.slice(0, -2)}ff` : "ff";
      const v: ScValue = { kind: "bytes", value: flipped === original.value ? `${original.value}00` : flipped };
      return isExcluded(v) ? null : v;
    }
    case "opaque":
      return null;
  }
}

function collectAddresses(recording: Recording): string[] {
  const set = new Set<string>([recording.account]);
  for (const entry of recording.entries) {
    for (const inv of flattenInvocations(entry)) {
      set.add(inv.contract);
      for (const a of inv.args) if (a.kind === "address") set.add(a.value);
    }
  }
  return [...set];
}
