import {
  Account,
  Address,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  hash,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import type { PolicySpec } from "@warden/core";
import {
  getLedgerEntries,
  getTransaction,
  sendTransaction,
  simulateTransaction,
  type GetTxResult,
} from "@warden/recorder";

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

/**
 * Sign one SorobanAuthorizationEntry for smart-account-lite with an ed25519
 * key (owner or session). Sets signatureExpirationLedger, signs the
 * ENVELOPE_TYPE_SOROBAN_AUTHORIZATION preimage, and encodes the signature as
 * the contract's `AccSignature { public_key, signature }` struct (a single
 * ScMap — NOT the Vec the built-in account contract expects).
 */
export function signSmartAccountAuthEntry(
  entry: xdr.SorobanAuthorizationEntry,
  signer: Keypair,
  validUntilLedger: number,
  networkPassphrase: string,
): xdr.SorobanAuthorizationEntry {
  const creds = entry.credentials().address();
  creds.signatureExpirationLedger(validUntilLedger);
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(networkPassphrase)),
      nonce: creds.nonce(),
      signatureExpirationLedger: validUntilLedger,
      invocation: entry.rootInvocation(),
    }),
  );
  const payload = hash(preimage.toXDR());
  const sym = (s: string) => nativeToScVal(s, { type: "symbol" });
  creds.signature(
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: sym("public_key"), val: xdr.ScVal.scvBytes(signer.rawPublicKey()) }),
      new xdr.ScMapEntry({ key: sym("signature"), val: xdr.ScVal.scvBytes(signer.sign(payload)) }),
    ]),
  );
  return entry;
}

/** Submit a signed tx and poll until it leaves PENDING. Throws on ERROR/FAILED with the result XDR. */
export async function submitTx(
  cfg: { rpcUrl: string },
  txB64: string,
  timeoutMs = 60_000,
): Promise<GetTxResult & { hash: string }> {
  const sent = await sendTransaction(cfg, txB64);
  if (sent.status === "ERROR")
    throw new TxFailedError(sent.hash, sent.errorResultXdr, sent.diagnosticEventsXdr);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await getTransaction(cfg, sent.hash);
    if (res.status === "SUCCESS") return { ...res, hash: sent.hash };
    if (res.status === "FAILED")
      throw new TxFailedError(sent.hash, res.resultXdr, res.diagnosticEventsXdr);
    if (Date.now() > deadline) throw new Error(`tx ${sent.hash} still pending after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** A transaction the network rejected — carries the hash so deny-case rejections are citable. */
export class TxFailedError extends Error {
  constructor(
    public readonly hash: string,
    public readonly resultXdr?: string,
    public readonly diagnosticEventsXdr?: string[],
  ) {
    super(`transaction ${hash} failed${resultXdr ? `: ${resultXdr}` : ""}`);
    this.name = "TxFailedError";
  }
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
