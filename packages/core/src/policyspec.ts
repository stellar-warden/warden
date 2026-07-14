/**
 * PolicySpec — the intermediate representation at the center of warden.
 *
 * Everything flows through this schema:
 *   recorder  → Recording        (facts: what the flow actually did)
 *   infer     → PolicySpec draft (heuristic generalization of those facts)
 *   advisor   → PolicySpec       (LLM-assisted refinement, ALWAYS re-validated here)
 *   codegen   → Rust             (deterministic; no model output ever becomes code directly)
 *   harness   → permit/deny run  (generated tests derived from Recording + mutations)
 *
 * Invariant: if it doesn't parse against this schema, it doesn't exist.
 * This is the verify gate — an LLM can propose, never dictate.
 */
import { z } from "zod";

/** 56-char Stellar strkey: G (classic account) or C (contract). */
export const StrKey = z
  .string()
  .regex(/^[GC][A-Z2-7]{55}$/, "expected a Stellar strkey (G... or C...)");

/** i128 carried as a decimal string to survive JSON. */
export const I128String = z.string().regex(/^-?\d{1,39}$/, "expected i128 as decimal string");

export const ScValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("address"), value: StrKey }),
  z.object({ kind: z.literal("i128"), value: I128String }),
  z.object({ kind: z.literal("u64"), value: z.string().regex(/^\d{1,20}$/) }),
  z.object({ kind: z.literal("u32"), value: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("symbol"), value: z.string().max(32) }),
  z.object({ kind: z.literal("string"), value: z.string() }),
  z.object({ kind: z.literal("bool"), value: z.boolean() }),
  z.object({ kind: z.literal("bytes"), value: z.string().regex(/^([0-9a-f]{2})*$/) }),
  /** Anything we don't yet model structurally; carried as base64 XDR, matched only as `exact`. */
  z.object({ kind: z.literal("opaque"), value: z.string() }),
]);
export type ScValue = z.infer<typeof ScValueSchema>;

/** Time window for rolling counters, enforced on-ledger via timestamps. */
export const WindowSchema = z.enum(["per-call", "hour", "day", "week", "month"]);
export type Window = z.infer<typeof WindowSchema>;

export const ArgConstraintSchema = z.discriminatedUnion("kind", [
  /** Argument must equal exactly this value. */
  z.object({ kind: z.literal("exact"), argIndex: z.number().int().nonnegative(), value: ScValueSchema }),
  /** Argument must be one of these values (e.g. destination allowlist). */
  z.object({
    kind: z.literal("anyOf"),
    argIndex: z.number().int().nonnegative(),
    values: z.array(ScValueSchema).min(1).max(64),
  }),
  /** Numeric cap with a rolling window; the on-chain counter lives in policy state. */
  z.object({
    kind: z.literal("cappedSum"),
    argIndex: z.number().int().nonnegative(),
    cap: I128String,
    window: WindowSchema,
  }),
  /** Explicitly unconstrained (must be stated, never implied). */
  z.object({ kind: z.literal("any"), argIndex: z.number().int().nonnegative() }),
]);
export type ArgConstraint = z.infer<typeof ArgConstraintSchema>;

export const RuleSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
    /** Contract this rule applies to. */
    contract: StrKey,
    /** Exact function name (Soroban symbol). */
    function: z.string().min(1).max(32),
    /** One entry per argument index that is constrained; unlisted args are DENIED unless argCount matches and each index has a constraint. */
    args: z.array(ArgConstraintSchema),
    /** Expected total argument count — a mismatch is a deny. */
    argCount: z.number().int().nonnegative(),
    note: z.string().max(200).optional(),
  })
  .superRefine((rule, ctx) => {
    const seen = new Set<number>();
    for (const a of rule.args) {
      if (a.argIndex >= rule.argCount)
        ctx.addIssue({ code: "custom", message: `argIndex ${a.argIndex} out of range for argCount ${rule.argCount}` });
      if (seen.has(a.argIndex))
        ctx.addIssue({ code: "custom", message: `duplicate constraint for argIndex ${a.argIndex}` });
      seen.add(a.argIndex);
    }
    for (let i = 0; i < rule.argCount; i++) {
      if (!seen.has(i))
        ctx.addIssue({ code: "custom", message: `argIndex ${i} has no constraint; add {kind:"any"} explicitly if intended` });
    }
  });
export type Rule = z.infer<typeof RuleSchema>;

export const SignerSchema = z.object({
  kind: z.literal("ed25519-session"),
  /** 32-byte public key, hex. */
  publicKeyHex: z.string().regex(/^[0-9a-f]{64}$/),
  /** Optional expiry as a ledger sequence; enforced by the account contract. */
  expiresLedger: z.number().int().positive().optional(),
  label: z.string().max(64).optional(),
});
export type Signer = z.infer<typeof SignerSchema>;

export const PolicySpecSchema = z.object({
  version: z.literal(1),
  /** The smart account (C-address) these rules govern. */
  account: StrKey,
  signer: SignerSchema,
  rules: z.array(RuleSchema).min(1).max(32),
  /** Structural deny-by-default. Not configurable — its presence keeps the property explicit in every artifact. */
  denyUnmatched: z.literal(true),
});
export type PolicySpec = z.infer<typeof PolicySpecSchema>;

/** Parse unknown input (e.g. LLM output) into a PolicySpec or throw with readable issues. */
export function parsePolicySpec(input: unknown): PolicySpec {
  const r = PolicySpecSchema.safeParse(input);
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("\n");
  throw new PolicySpecError(issues);
}

export class PolicySpecError extends Error {
  constructor(public readonly issues: string) {
    super(`PolicySpec validation failed:\n${issues}`);
    this.name = "PolicySpecError";
  }
}
