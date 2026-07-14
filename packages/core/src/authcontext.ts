/**
 * Recording — the facts extracted from simulating a transaction flow.
 *
 * A Recording is chain-agnostic JSON: the recorder package owns all XDR
 * handling and emits this shape; nothing downstream touches stellar-sdk.
 * That boundary keeps synthesizer/harness pure and unit-testable.
 */
import { z } from "zod";
import { ScValueSchema, StrKey } from "./policyspec.js";

export const InvocationSchema: z.ZodType<Invocation> = z.lazy(() =>
  z.object({
    contract: StrKey,
    function: z.string(),
    args: z.array(ScValueSchema),
    subInvocations: z.array(InvocationSchema),
  }),
);
export interface Invocation {
  contract: string;
  function: string;
  args: Array<z.infer<typeof ScValueSchema>>;
  subInvocations: Invocation[];
}

export const RecordedEntrySchema = z.object({
  /** Address whose authorization this entry represents (the smart account). */
  credentialAddress: StrKey.optional(),
  rootInvocation: InvocationSchema,
});
export type RecordedEntry = z.infer<typeof RecordedEntrySchema>;

export const RecordingSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[a-z0-9-]{4,64}$/),
  createdAt: z.string(),
  network: z.object({ rpcUrl: z.string().url(), passphrase: z.string() }),
  /** The account we intend to govern (auth entries for other addresses are kept but flagged). */
  account: StrKey,
  label: z.string().max(120).optional(),
  entries: z.array(RecordedEntrySchema).min(1),
});
export type Recording = z.infer<typeof RecordingSchema>;

/** Flatten an invocation tree into (contract, function, args) call sites, depth-first. */
export function flattenInvocations(entry: RecordedEntry): Invocation[] {
  const out: Invocation[] = [];
  const walk = (inv: Invocation) => {
    out.push(inv);
    inv.subInvocations.forEach(walk);
  };
  walk(entry.rootInvocation);
  return out;
}

export function parseRecording(input: unknown): Recording {
  const r = RecordingSchema.safeParse(input);
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
  throw new Error(`Recording validation failed:\n${issues}`);
}
