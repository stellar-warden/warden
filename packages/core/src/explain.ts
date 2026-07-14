import type { ArgConstraint, PolicySpec, Rule, ScValue } from "./policyspec.js";

/**
 * Deterministic English rendering of a PolicySpec.
 * Used by the CLI, the MCP `explain_policy` tool, and embedded at the top of
 * every generated Rust file — so the human-readable contract and the code
 * are produced from the same source and cannot drift.
 */
export function explainPolicy(spec: PolicySpec): string {
  const lines: string[] = [];
  const signerLabel = spec.signer.label ?? `session key ${spec.signer.publicKeyHex.slice(0, 8)}…`;
  lines.push(`Account ${short(spec.account)} grants "${signerLabel}" permission to do EXACTLY the following:`);
  spec.rules.forEach((r, i) => lines.push(`  ${i + 1}. ${explainRule(r)}`));
  if (spec.signer.expiresLedger) lines.push(`This grant expires at ledger ${spec.signer.expiresLedger}.`);
  lines.push(`Anything not listed above is DENIED, including the same functions with different arguments.`);
  return lines.join("\n");
}

export function explainRule(r: Rule): string {
  const constraints = r.args
    .filter((a) => a.kind !== "any")
    .map(explainConstraint)
    .join("; ");
  const anyCount = r.args.filter((a) => a.kind === "any").length;
  const tail = anyCount > 0 ? ` (${anyCount} argument${anyCount > 1 ? "s" : ""} unconstrained)` : "";
  return `call ${short(r.contract)}::${r.function}(${r.argCount} args)${constraints ? ` where ${constraints}` : ""}${tail}`;
}

function explainConstraint(a: ArgConstraint): string {
  switch (a.kind) {
    case "exact":
      return `arg${a.argIndex} == ${renderValue(a.value)}`;
    case "anyOf":
      return `arg${a.argIndex} ∈ {${a.values.map(renderValue).join(", ")}}`;
    case "cappedSum":
      return `sum(arg${a.argIndex}) ≤ ${a.cap} per ${a.window}`;
    case "any":
      return `arg${a.argIndex} unconstrained`;
  }
}

export function renderValue(v: ScValue): string {
  switch (v.kind) {
    case "address":
      return short(v.value);
    case "bytes":
      return `0x${v.value.slice(0, 12)}${v.value.length > 12 ? "…" : ""}`;
    case "opaque":
      return "<opaque xdr>";
    default:
      return String(v.value);
  }
}

function short(strkey: string): string {
  return `${strkey.slice(0, 4)}…${strkey.slice(-4)}`;
}
