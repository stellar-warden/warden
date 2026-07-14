import {
  Account,
  Address,
  Contract,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import type { PolicySpec } from "@warden/core";
import { getLedgerEntries, simulateTransaction } from "@warden/recorder";

/**
 * @warden/sdk — the install seam.
 *
 * v1 targets the bundled smart-account-lite contract, whose on-chain rule
 * format is a deliberately compact SUBSET of PolicySpec:
 *   - one address-allowlist constraint per rule (dest_index / dests)
 *   - one rolling cap per rule (cap_index / cap / window)
 *   - everything else must be `any`
 *
 * Anything richer belongs to the full generated-crate path (and the
 * OpenZeppelin adapter on the roadmap). specToStoredRules REFUSES specs it
 * cannot represent faithfully — silent widening is the one unforgivable bug
 * in this codebase.
 */

const NONE = 0xffffffff; // u32::MAX sentinel, mirrored in smart-account-lite

export interface StoredRule {
  arg_count: number;
  cap: bigint;
  cap_index: number;
  contract: string;
  dest_index: number;
  dests: string[];
  function: string;
  window: bigint;
}

const WINDOW_SECONDS: Record<string, bigint> = {
  "per-call": 0n,
  hour: 3600n,
  day: 86400n,
  week: 604800n,
  month: 2592000n,
};

export function specToStoredRules(spec: PolicySpec): StoredRule[] {
  return spec.rules.map((rule) => {
    const stored: StoredRule = {
      arg_count: rule.argCount,
      cap: 0n,
      cap_index: NONE,
      contract: rule.contract,
      dest_index: NONE,
      dests: [],
      function: rule.function,
      window: 0n,
    };
    for (const c of rule.args) {
      switch (c.kind) {
        case "any":
          break;
        case "anyOf": {
          if (!c.values.every((v) => v.kind === "address"))
            throw new UnsupportedSpecError(rule.id, `anyOf on non-address arg${c.argIndex}`);
          if (stored.dest_index !== NONE)
            throw new UnsupportedSpecError(rule.id, "more than one address allowlist");
          stored.dest_index = c.argIndex;
          stored.dests = c.values.map((v) => v.value as string);
          break;
        }
        case "exact": {
          if (c.value.kind !== "address")
            throw new UnsupportedSpecError(rule.id, `exact match on ${c.value.kind} arg${c.argIndex}`);
          if (stored.dest_index !== NONE)
            throw new UnsupportedSpecError(rule.id, "more than one address constraint");
          stored.dest_index = c.argIndex;
          stored.dests = [c.value.value];
          break;
        }
        case "cappedSum": {
          if (stored.cap_index !== NONE) throw new UnsupportedSpecError(rule.id, "more than one cap");
          stored.cap_index = c.argIndex;
          stored.cap = BigInt(c.cap);
          stored.window = WINDOW_SECONDS[c.window] ?? 0n;
          if (stored.cap <= 0n) throw new UnsupportedSpecError(rule.id, "cap must be positive");
          break;
        }
      }
    }
    return stored;
  });
}

export class UnsupportedSpecError extends Error {
  constructor(ruleId: string, detail: string) {
    super(
      `rule '${ruleId}' cannot be represented in smart-account-lite's compact format (${detail}). ` +
        `Use the generated-crate path, or simplify the constraint.`,
    );
    this.name = "UnsupportedSpecError";
  }
}

export interface InstallParams {
  rpcUrl: string;
  networkPassphrase: string;
  /** Funded G-address paying fees. The OWNER's require_auth is what actually authorizes add_signer. */
  source: string;
  spec: PolicySpec;
  rules: StoredRule[];
}

/** Build the UNSIGNED, simulation-assembled transaction calling add_signer on the account. */
export async function buildAddSignerTx(p: InstallParams): Promise<string> {
  const cfg = { rpcUrl: p.rpcUrl };
  const seq = await fetchSequence(cfg, p.source);
  const pk = Buffer.from(p.spec.signer.publicKeyHex, "hex");
  const expires = p.spec.signer.expiresLedger ?? 0;

  const call = new Contract(p.spec.account).call(
    "add_signer",
    xdr.ScVal.scvBytes(pk),
    nativeToScVal(expires, { type: "u32" }),
    xdr.ScVal.scvVec(p.rules.map(storedRuleToScVal)),
  );

  const tx = new TransactionBuilder(new Account(p.source, seq), {
    fee: "10000",
    networkPassphrase: p.networkPassphrase,
  })
    .addOperation(call)
    .setTimeout(300)
    .build();

  const sim = await simulateTransaction(cfg, tx.toXDR());
  if (sim.error) throw new Error(`install simulation failed: ${sim.error}`);
  if (!sim.transactionData || sim.minResourceFee === undefined)
    throw new Error("simulation response missing transactionData — is the account contract deployed?");

  const op = tx.operations[0] as Operation.InvokeHostFunction;
  const auth = (sim.results?.[0]?.auth ?? []).map((b) => xdr.SorobanAuthorizationEntry.fromXDR(b, "base64"));
  const assembled = TransactionBuilder.cloneFrom(tx, {
    fee: (Number(tx.fee) + Number(sim.minResourceFee)).toString(),
    sorobanData: xdr.SorobanTransactionData.fromXDR(sim.transactionData, "base64"),
  })
    .clearOperations()
    .addOperation(Operation.invokeHostFunction({ func: op.func, auth }))
    .build();

  return assembled.toXDR();
}

/** Encode a StoredRule as the ScMap soroban's #[contracttype] expects (keys sorted). */
function storedRuleToScVal(r: StoredRule): xdr.ScVal {
  const entry = (key: string, val: xdr.ScVal) =>
    new xdr.ScMapEntry({ key: nativeToScVal(key, { type: "symbol" }), val });
  return xdr.ScVal.scvMap([
    entry("arg_count", nativeToScVal(r.arg_count, { type: "u32" })),
    entry("cap", nativeToScVal(r.cap, { type: "i128" })),
    entry("cap_index", nativeToScVal(r.cap_index, { type: "u32" })),
    entry("contract", new Address(r.contract).toScVal()),
    entry("dest_index", nativeToScVal(r.dest_index, { type: "u32" })),
    entry("dests", xdr.ScVal.scvVec(r.dests.map((d) => new Address(d).toScVal()))),
    entry("function", nativeToScVal(r.function, { type: "symbol" })),
    entry("window", nativeToScVal(r.window, { type: "u64" })),
  ]);
}

async function fetchSequence(cfg: { rpcUrl: string }, g: string): Promise<string> {
  const key = xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: xdr.PublicKey.publicKeyTypeEd25519(Address.fromString(g).toBuffer()) }),
  );
  const res = await getLedgerEntries(cfg, [key.toXDR("base64")]);
  const entry = res.entries?.[0];
  if (!entry) throw new Error(`source account ${g} not found on this network`);
  return xdr.LedgerEntryData.fromXDR(entry.xdr, "base64").account().seqNum().toString();
}
