import {
  Account,
  Address,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import type { Invocation, RecordedEntry, Recording, ScValue } from "@stellar-warden/core";
import { getLedgerEntries, simulateTransaction, type RpcConfig } from "./rpc.js";

export interface RecordCallParams {
  rpcUrl: string;
  networkPassphrase: string;
  /** Fee-paying G-address used as tx source for simulation (must exist; friendbot on testnet). */
  source: string;
  /** The account being governed — auth entries for this address are what we record. */
  account: string;
  contract: string;
  method: string;
  args: ScValue[];
  label?: string;
}

/** Simulate a single contract call and capture the authorization it would require. */
export async function recordContractCall(p: RecordCallParams): Promise<Recording> {
  const cfg: RpcConfig = { rpcUrl: p.rpcUrl };
  const seq = await fetchSequence(cfg, p.source);
  const source = new Account(p.source, seq);
  const tx = new TransactionBuilder(source, { fee: "10000", networkPassphrase: p.networkPassphrase })
    .addOperation(new Contract(p.contract).call(p.method, ...p.args.map(toScVal)))
    .setTimeout(300)
    .build();

  const sim = await simulateTransaction(cfg, tx.toXDR());
  if (sim.error) throw new Error(`simulation failed: ${sim.error}`);
  const authB64 = sim.results?.flatMap((r) => r.auth ?? []) ?? [];
  if (authB64.length === 0)
    throw new Error(
      "simulation produced no authorization entries — the call requires no auth, or the source itself is the authorizer",
    );

  return {
    version: 1,
    id: newId(),
    createdAt: new Date().toISOString(),
    network: { rpcUrl: p.rpcUrl, passphrase: p.networkPassphrase },
    account: p.account,
    label: p.label,
    entries: authB64.map((b64) => extractEntry(xdr.SorobanAuthorizationEntry.fromXDR(b64, "base64"))),
  };
}

/** Simulate a caller-provided transaction envelope (advanced path; lets wallets hand us full flows). */
export async function recordFromEnvelope(
  rpcUrl: string,
  passphrase: string,
  account: string,
  envelopeB64: string,
  label?: string,
): Promise<Recording> {
  const sim = await simulateTransaction({ rpcUrl }, envelopeB64);
  if (sim.error) throw new Error(`simulation failed: ${sim.error}`);
  const authB64 = sim.results?.flatMap((r) => r.auth ?? []) ?? [];
  if (authB64.length === 0) throw new Error("simulation produced no authorization entries");
  return {
    version: 1,
    id: newId(),
    createdAt: new Date().toISOString(),
    network: { rpcUrl, passphrase },
    account,
    label,
    entries: authB64.map((b64) => extractEntry(xdr.SorobanAuthorizationEntry.fromXDR(b64, "base64"))),
  };
}

// ---------------------------------------------------------------------------
// XDR → domain
// ---------------------------------------------------------------------------

function extractEntry(entry: xdr.SorobanAuthorizationEntry): RecordedEntry {
  let credentialAddress: string | undefined;
  const creds = entry.credentials();
  if (creds.switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress()) {
    credentialAddress = Address.fromScAddress(creds.address().address()).toString();
  }
  return { credentialAddress, rootInvocation: extractInvocation(entry.rootInvocation()) };
}

function extractInvocation(inv: xdr.SorobanAuthorizedInvocation): Invocation {
  const fn = inv.function();
  if (fn.switch() !== xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()) {
    // Contract-creation authorizations are out of scope for v1 policies; record opaquely.
    return {
      contract: "C" + "A".repeat(55),
      function: "__create_contract__",
      args: [{ kind: "opaque", value: inv.toXDR("base64") }],
      subInvocations: [],
    };
  }
  const call = fn.contractFn();
  return {
    contract: Address.fromScAddress(call.contractAddress()).toString(),
    function: call.functionName().toString(),
    args: call.args().map(fromScVal),
    subInvocations: inv.subInvocations().map(extractInvocation),
  };
}

export function fromScVal(v: xdr.ScVal): ScValue {
  switch (v.switch()) {
    case xdr.ScValType.scvAddress():
      return { kind: "address", value: Address.fromScAddress(v.address()).toString() };
    case xdr.ScValType.scvI128(): {
      const parts = v.i128();
      const hi = BigInt(parts.hi().toString());
      const lo = BigInt(parts.lo().toString());
      return { kind: "i128", value: ((hi << 64n) | lo).toString() };
    }
    case xdr.ScValType.scvU64():
      return { kind: "u64", value: v.u64().toString() };
    case xdr.ScValType.scvU32():
      return { kind: "u32", value: v.u32() };
    case xdr.ScValType.scvSymbol():
      return { kind: "symbol", value: v.sym().toString() };
    case xdr.ScValType.scvString():
      return { kind: "string", value: v.str().toString() };
    case xdr.ScValType.scvBool():
      return { kind: "bool", value: v.b() };
    case xdr.ScValType.scvBytes():
      return { kind: "bytes", value: Buffer.from(v.bytes()).toString("hex") };
    default:
      return { kind: "opaque", value: v.toXDR("base64") };
  }
}

export function toScVal(v: ScValue): xdr.ScVal {
  switch (v.kind) {
    case "address":
      return new Address(v.value).toScVal();
    case "i128":
      return nativeToScVal(BigInt(v.value), { type: "i128" });
    case "u64":
      return nativeToScVal(BigInt(v.value), { type: "u64" });
    case "u32":
      return nativeToScVal(v.value, { type: "u32" });
    case "symbol":
      return nativeToScVal(v.value, { type: "symbol" });
    case "string":
      return nativeToScVal(v.value, { type: "string" });
    case "bool":
      return nativeToScVal(v.value);
    case "bytes":
      return nativeToScVal(Buffer.from(v.value, "hex"), { type: "bytes" });
    case "opaque":
      return xdr.ScVal.fromXDR(v.value, "base64");
  }
}

async function fetchSequence(cfg: RpcConfig, g: string): Promise<string> {
  const key = xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: xdr.PublicKey.publicKeyTypeEd25519(Address.fromString(g).toBuffer()) }),
  );
  const res = await getLedgerEntries(cfg, [key.toXDR("base64")]);
  const entry = res.entries?.[0];
  if (!entry) throw new Error(`source account ${g} not found on this network (fund it via friendbot on testnet)`);
  const data = xdr.LedgerEntryData.fromXDR(entry.xdr, "base64");
  return data.account().seqNum().toString();
}

function newId(): string {
  return `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
