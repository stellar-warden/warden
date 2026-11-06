import {
  Account,
  Address,
  Contract,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  hash,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import type { PolicySpec, ScValue } from "@warden/core";
import {
  getLatestLedger,
  getLedgerEntries,
  getTransaction,
  sendTransaction,
  simulateTransaction,
  toScVal,
  type GetTxResult,
} from "@warden/recorder";

/**
 * @warden/sdk — the install seam.
 *
 * v1 targets the bundled smart-account-lite contract, whose on-chain rule
 * format is compact:
 *   - any number of argument matches per rule (`exact` = one allowed value,
 *     `anyOf` = several), compared on-chain as raw ScVals
 *   - one rolling cap per rule (cap_index / cap / window)
 *
 * The one thing it cannot hold is a second cap on the same rule; that belongs
 * to the full generated-crate path (and the OpenZeppelin adapter on the
 * roadmap). specToStoredRules REFUSES specs it cannot represent faithfully —
 * silent widening is the one unforgivable bug in this codebase.
 */

/** Re-exported so callers can load signing keys without depending on stellar-sdk directly. */
export { Keypair };

const NONE = 0xffffffff; // u32::MAX sentinel, mirrored in smart-account-lite

export interface StoredArgMatch {
  allowed: ScValue[];
  index: number;
}

export interface StoredRule {
  arg_count: number;
  cap: bigint;
  cap_index: number;
  contract: string;
  function: string;
  matches: StoredArgMatch[];
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
  const targets = new Set<string>();
  return spec.rules.map((rule) => {
    // The account enforces the FIRST rule matching (contract, function).
    const target = `${rule.contract}::${rule.function}`;
    if (targets.has(target)) throw new UnsupportedSpecError(rule.id, "second rule for the same contract function");
    targets.add(target);

    const stored: StoredRule = {
      arg_count: rule.argCount,
      cap: 0n,
      cap_index: NONE,
      contract: rule.contract,
      function: rule.function,
      matches: [],
      window: 0n,
    };
    for (const c of rule.args) {
      switch (c.kind) {
        case "any":
          break;
        case "anyOf":
          stored.matches.push({ allowed: c.values, index: c.argIndex });
          break;
        case "exact":
          stored.matches.push({ allowed: [c.value], index: c.argIndex });
          break;
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
  const pk = Buffer.from(p.spec.signer.publicKeyHex, "hex");
  const expires = p.spec.signer.expiresLedger ?? 0;
  const call = new Contract(p.spec.account).call(
    "add_signer",
    xdr.ScVal.scvBytes(pk),
    nativeToScVal(expires, { type: "u32" }),
    xdr.ScVal.scvVec(p.rules.map(storedRuleToScVal)),
  );
  return buildUnsignedInvoke(p, call, "install");
}

export interface InvokeParams {
  rpcUrl: string;
  networkPassphrase: string;
  /** Funded G-address paying fees. */
  source: string;
  contract: string;
  method: string;
  args: ScValue[];
}

/** Build the UNSIGNED transaction for an arbitrary contract call (what a session key then authorizes). */
export function buildInvokeTx(p: InvokeParams): Promise<string> {
  return buildUnsignedInvoke(p, new Contract(p.contract).call(p.method, ...p.args.map(toScVal)), p.method);
}

const BASE_FEE = 10_000;

async function buildUnsignedInvoke(
  p: { rpcUrl: string; networkPassphrase: string; source: string },
  call: xdr.Operation,
  what: string,
): Promise<string> {
  const cfg = { rpcUrl: p.rpcUrl };
  const seq = await fetchSequence(cfg, p.source);
  const tx = new TransactionBuilder(new Account(p.source, seq), {
    fee: BASE_FEE.toString(),
    networkPassphrase: p.networkPassphrase,
  })
    .addOperation(call)
    .setTimeout(300)
    .build();

  const sim = await simulateTransaction(cfg, tx.toXDR());
  if (sim.error) throw new Error(`${what} simulation failed: ${sim.error}`);
  if (!sim.transactionData || sim.minResourceFee === undefined)
    throw new Error("simulation response missing transactionData — is the contract deployed?");

  const op = tx.operations[0] as Operation.InvokeHostFunction;
  const auth = (sim.results?.[0]?.auth ?? []).map((b) => xdr.SorobanAuthorizationEntry.fromXDR(b, "base64"));
  const assembled = TransactionBuilder.cloneFrom(tx, {
    fee: (BASE_FEE + Number(sim.minResourceFee)).toString(),
    sorobanData: xdr.SorobanTransactionData.fromXDR(sim.transactionData, "base64"),
  })
    .clearOperations()
    .addOperation(Operation.invokeHostFunction({ func: op.func, auth }))
    .build();

  return assembled.toXDR();
}

export interface SignParams {
  rpcUrl: string;
  networkPassphrase: string;
  /** Unsigned XDR from buildAddSignerTx / buildInvokeTx. */
  txB64: string;
  /** The smart account whose auth entries `signer` signs. */
  account: string;
  /** Owner key (install) or session key (acting under the policy). */
  signer: Keypair;
  /** Key of the transaction source; pays fees, holds no authority over the account. */
  feeSigner: Keypair;
  /** How long the auth signature stays valid, in ledgers (~5s each). */
  validLedgers?: number;
}

/**
 * Turn an unsigned invoke into a submit-ready transaction: sign the smart
 * account's auth entries, re-simulate so `__check_auth` actually runs (its
 * footprint and cost are not in the unsigned tx — and a policy denial
 * surfaces here as PolicyDeniedError), then sign the envelope.
 */
export async function signSmartAccountTx(p: SignParams): Promise<string> {
  const cfg = { rpcUrl: p.rpcUrl };
  const tx = TransactionBuilder.fromXDR(p.txB64, p.networkPassphrase) as Transaction;
  if (tx.source !== p.feeSigner.publicKey())
    throw new Error(`fee key ${p.feeSigner.publicKey()} is not the transaction source ${tx.source}`);
  const op = tx.operations[0] as Operation.InvokeHostFunction;
  if (tx.operations.length !== 1 || op.type !== "invokeHostFunction")
    throw new Error("expected a single invokeHostFunction operation");

  const validUntil = (await getLatestLedger(cfg)).sequence + (p.validLedgers ?? 120);
  let signed = 0;
  const auth = (op.auth ?? []).map((e) => {
    if (credentialAddress(e) !== p.account) return e;
    signed += 1;
    return signSmartAccountAuthEntry(e, p.signer, validUntil, p.networkPassphrase);
  });
  if (signed === 0) throw new Error(`transaction needs no authorization from ${p.account}`);

  const withAuth = TransactionBuilder.cloneFrom(tx, { fee: BASE_FEE.toString() })
    .clearOperations()
    .addOperation(Operation.invokeHostFunction({ func: op.func, auth }))
    .build();
  const sim = await simulateTransaction(cfg, withAuth.toXDR());
  if (sim.error) throw new PolicyDeniedError(sim.error);
  if (!sim.transactionData || sim.minResourceFee === undefined)
    throw new Error("simulation returned no transactionData");

  const final = TransactionBuilder.cloneFrom(withAuth, {
    fee: (BASE_FEE + Number(sim.minResourceFee)).toString(),
    sorobanData: xdr.SorobanTransactionData.fromXDR(sim.transactionData, "base64"),
  }).build();
  final.sign(p.feeSigner);
  return final.toXDR();
}

/** The account's `__check_auth` (or the call itself) rejected the transaction during simulation. */
export class PolicyDeniedError extends Error {
  constructor(public readonly detail: string) {
    const code = /failed account authentication[^\n]*Error\(Contract, #(\d+)\)/.exec(detail)?.[1];
    const reason = code ? `${ACCOUNT_ERRORS[Number(code)] ?? "unknown error"} (account error #${code})` : detail;
    super(`rejected in simulation: ${reason}`);
    this.name = "PolicyDeniedError";
  }
}

/** smart-account-lite's `AccError` codes. */
const ACCOUNT_ERRORS: Record<number, string> = {
  1: "NotInitialized",
  2: "AlreadyInitialized",
  3: "UnknownSigner",
  4: "SignerExpired",
  5: "UnsupportedContext",
  6: "NoMatchingRule",
  7: "ArgCountMismatch",
  8: "ArgNotAllowed",
  9: "BadArgType",
  10: "CapExceeded",
};

function credentialAddress(e: xdr.SorobanAuthorizationEntry): string | undefined {
  if (e.credentials().switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) return undefined;
  return Address.fromScAddress(e.credentials().address().address()).toString();
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
    entry("function", nativeToScVal(r.function, { type: "symbol" })),
    entry(
      "matches",
      xdr.ScVal.scvVec(
        r.matches.map((m) =>
          xdr.ScVal.scvMap([
            entry("allowed", xdr.ScVal.scvVec(m.allowed.map(toScVal))),
            entry("index", nativeToScVal(m.index, { type: "u32" })),
          ]),
        ),
      ),
    ),
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
