/**
 * `warden demo` — the whole loop, live on Stellar testnet, from nothing.
 *
 * No clone, no pre-existing keys, no Rust toolchain. It:
 *   1. generates throwaway owner / session / fee keys and funds the fee key via friendbot
 *   2. deploys a fresh smart-account-lite plus a mock token and a mock yield pool
 *      (wasm is bundled in this package) and seeds them
 *   3. RECORDS a claim + payroll transfer by simulating them against the live contracts
 *   4. PROPOSES the least-authority policy and prints it in plain English
 *   5. INSTALLS it (owner signs add_signer)
 *   6. PROVES it: session key claim ✓, transfer within cap ✓, second transfer over the
 *      rolling weekly cap ✗ — rejected on-chain by the account's __check_auth
 *
 * Testnet only (it uses friendbot). The token and pool are labelled mocks.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Account,
  Address,
  Contract,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { explainPolicy, type Recording } from "@stellar-warden/core";
import {
  getLatestLedger,
  getLedgerEntries,
  recordContractCall,
  simulateTransaction,
} from "@stellar-warden/recorder";
import { inferPolicy } from "@stellar-warden/synthesizer";
import {
  buildAddSignerTx,
  signSmartAccountAuthEntry,
  specToStoredRules,
  submitTx,
  TxFailedError,
} from "@stellar-warden/sdk";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const EXPLORER = "https://stellar.expert/explorer/testnet";

// 7-decimal units: the recorded transfer sets the weekly cap at 150; two live
// transfers of 120 then bust it on the second attempt.
const RECORDED_TRANSFER = 1_500_000_000n;
const LIVE_TRANSFER = 1_200_000_000n;
const SEED_BALANCE = 10_000_000_000n;
const SEED_YIELD = 700_000_000n;

export interface DemoOptions {
  rpcUrl: string;
  passphrase: string;
}

export interface DemoResult {
  contracts: { token: string; pool: string; account: string };
  txs: { install: string; permitClaim: string; permitTransfer: string; denyTransferCapExceeded: string };
}

export async function runDemo(opts: DemoOptions): Promise<DemoResult> {
  if (opts.passphrase !== TESTNET_PASSPHRASE)
    throw new Error("`warden demo` is testnet-only (it funds keys via friendbot).");
  const cfg = { rpcUrl: opts.rpcUrl };
  const passphrase = opts.passphrase;

  const owner = Keypair.random();
  const session = Keypair.random();
  const fee = Keypair.random();
  const alice = Keypair.random().publicKey();

  // -- 0. keys ---------------------------------------------------------------
  log("keys", `throwaway fee ${fee.publicKey()} (funding via friendbot…)`);
  await friendbot(fee.publicKey());

  const chain = new Chain(cfg, passphrase, fee);

  // -- 1. deploy --------------------------------------------------------------
  const mockWasm = loadWasm("mock_protocols.wasm");
  const accountWasm = loadWasm("smart_account_lite.wasm");
  log("deploy", "uploading wasm + creating contracts (mock token, mock pool, smart-account-lite)…");
  const mockHash = await chain.upload(mockWasm);
  const accountHash = await chain.upload(accountWasm);
  const token = await chain.create(mockHash);
  const pool = await chain.create(mockHash);
  const account = await chain.create(accountHash);
  log("deploy", `token   ${EXPLORER}/contract/${token}  (mock)`);
  log("deploy", `pool    ${EXPLORER}/contract/${pool}  (mock)`);
  log("deploy", `account ${EXPLORER}/contract/${account}  (smart-account-lite)`);

  await chain.call(account, "init", [xdr.ScVal.scvBytes(owner.rawPublicKey())]);
  await chain.call(token, "mint", [addr(account), i128(SEED_BALANCE)]);
  await chain.call(pool, "set_yield", [addr(account), i128(SEED_YIELD)]);
  log("deploy", "initialised account with the owner key and seeded token + yield");

  // -- 2. record --------------------------------------------------------------
  log("record", "simulating claim + payroll transfer against the live contracts…");
  const base = { rpcUrl: cfg.rpcUrl, networkPassphrase: passphrase, source: fee.publicKey(), account };
  const recClaim = await recordContractCall({
    ...base,
    contract: pool,
    method: "claim",
    args: [
      { kind: "address", value: account },
      { kind: "u32", value: 0 },
    ],
    label: "claim yield",
  });
  const recPay = await recordContractCall({
    ...base,
    contract: token,
    method: "transfer",
    args: [
      { kind: "address", value: account },
      { kind: "address", value: alice },
      { kind: "i128", value: RECORDED_TRANSFER.toString() },
    ],
    label: "payroll transfer",
  });
  const recording: Recording = {
    version: 1,
    id: "demo_live",
    createdAt: new Date().toISOString(),
    network: { rpcUrl: cfg.rpcUrl, passphrase },
    account,
    label: "claim yield, convert to payroll transfers (demo)",
    entries: [...recClaim.entries, ...recPay.entries],
  };

  // -- 3. propose + review ----------------------------------------------------
  const latest = await getLatestLedger(cfg);
  const { spec } = inferPolicy(recording, {
    kind: "ed25519-session",
    publicKeyHex: session.rawPublicKey().toString("hex"),
    expiresLedger: latest.sequence + 17_280, // ~1 day
    label: "payroll-agent",
  });
  log("propose", "least-authority policy the owner reviews before signing:");
  console.log(explainPolicy(spec));

  // -- 4. install -------------------------------------------------------------
  const unsignedB64 = await buildAddSignerTx({
    rpcUrl: cfg.rpcUrl,
    networkPassphrase: passphrase,
    source: fee.publicKey(),
    spec,
    rules: specToStoredRules(spec),
  });
  const validUntil = (await getLatestLedger(cfg)).sequence + 120; // ~10 min
  const unsigned = TransactionBuilder.fromXDR(unsignedB64, passphrase) as Transaction;
  const installOp = unsigned.operations[0] as Operation.InvokeHostFunction;
  const installAuth = (installOp.auth ?? []).map((e) =>
    credential(e) === account ? signSmartAccountAuthEntry(e, owner, validUntil, passphrase) : e,
  );
  const install = await chain.submit(Operation.invokeHostFunction({ func: installOp.func, auth: installAuth }));
  log("install", `owner signed add_signer: ${EXPLORER}/tx/${install}`);

  // -- 5. prove ---------------------------------------------------------------
  // Assemble all three session txs up front: the deny tx must be simulated while
  // the rolling counter is still empty (exactly what a greedy session key would
  // try), so the rejection happens in consensus, not in simulation.
  const mk = (contract: string, method: string, args: xdr.ScVal[], offset: number) =>
    chain.sessionTx(contract, method, args, account, session, validUntil, offset);
  const transfer = [addr(account), addr(alice), i128(LIVE_TRANSFER)];
  const claimTx = await mk(pool, "claim", [addr(account), nativeToScVal(0, { type: "u32" })], 0);
  const payTx = await mk(token, "transfer", transfer, 1);
  const denyTx = await mk(token, "transfer", transfer, 2);

  const claimRes = await submitTx(cfg, claimTx);
  log("permit", `session key claimed yield:       ${EXPLORER}/tx/${claimRes.hash}`);
  const payRes = await submitTx(cfg, payTx);
  log("permit", `transfer 120 (cap 150/week):     ${EXPLORER}/tx/${payRes.hash}`);

  let denyHash = "";
  try {
    await submitTx(cfg, denyTx);
    throw new Error("DENY TX WAS ACCEPTED — the policy did not hold");
  } catch (err) {
    if (!(err instanceof TxFailedError)) throw err;
    denyHash = err.hash;
    log("deny", `second transfer (sum 240 > 150): ${EXPLORER}/tx/${err.hash}  REJECTED on-chain`);
  }

  const aliceBal = await chain.tokenBalance(token, alice);
  if (aliceBal !== LIVE_TRANSFER) throw new Error(`payee balance ${aliceBal} ≠ ${LIVE_TRANSFER}`);
  log("check", `payee received exactly ${aliceBal} (one transfer, not two)`);

  return {
    contracts: { token, pool, account },
    txs: {
      install,
      permitClaim: claimRes.hash,
      permitTransfer: payRes.hash,
      denyTransferCapExceeded: denyHash,
    },
  };
}

// ---------------------------------------------------------------------------

/** Fee-paying account plus the simulate → assemble → sign → submit plumbing. */
class Chain {
  constructor(
    private readonly cfg: { rpcUrl: string },
    private readonly passphrase: string,
    private readonly fee: Keypair,
  ) {}

  async upload(wasm: Buffer): Promise<Buffer> {
    await this.submit(Operation.uploadContractWasm({ wasm }));
    return createHash("sha256").update(wasm).digest();
  }

  /** Deploy an instance; the new contract id comes back as the simulation's return value. */
  async create(wasmHash: Buffer): Promise<string> {
    const op = Operation.createCustomContract({
      address: new Address(this.fee.publicKey()),
      wasmHash,
      salt: Keypair.random().rawPublicKey(),
    });
    const { assembled, sim } = await this.assemble(op, undefined, 0);
    await submitTx(this.cfg, assembled);
    const ret = sim.results?.[0]?.xdr;
    if (!ret) throw new Error("create contract simulation returned no contract id");
    return Address.fromScVal(xdr.ScVal.fromXDR(ret, "base64")).toString();
  }

  call(contract: string, method: string, args: xdr.ScVal[]): Promise<string> {
    return this.submit(new Contract(contract).call(method, ...args));
  }

  async submit(op: xdr.Operation): Promise<string> {
    const { assembled } = await this.assemble(op, undefined, 0);
    return (await submitTx(this.cfg, assembled)).hash;
  }

  /** Build + simulate a session-key invocation; returns signed, submit-ready XDR. */
  async sessionTx(
    contract: string,
    method: string,
    args: xdr.ScVal[],
    account: string,
    session: Keypair,
    validUntil: number,
    seqOffset: number,
  ): Promise<string> {
    const op = new Contract(contract).call(method, ...args);
    const raw = new TransactionBuilder(await this.source(seqOffset), { fee: "10000", networkPassphrase: this.passphrase })
      .addOperation(op)
      .setTimeout(300)
      .build();
    const sim = await simulateTransaction(this.cfg, raw.toXDR());
    if (sim.error) throw new Error(`${method} simulation failed: ${sim.error}`);
    const auth = (sim.results?.[0]?.auth ?? []).map((b) => {
      const e = xdr.SorobanAuthorizationEntry.fromXDR(b, "base64");
      return credential(e) === account ? signSmartAccountAuthEntry(e, session, validUntil, this.passphrase) : e;
    });
    const func = (raw.operations[0] as Operation.InvokeHostFunction).func;
    const { assembled } = await this.assemble(Operation.invokeHostFunction({ func, auth }), auth, seqOffset);
    return assembled;
  }

  /** Simulate in enforce mode (so __check_auth really runs), attach resources + fee signature. */
  private async assemble(
    op: xdr.Operation,
    auth: xdr.SorobanAuthorizationEntry[] | undefined,
    seqOffset: number,
  ): Promise<{ assembled: string; sim: Awaited<ReturnType<typeof simulateTransaction>> }> {
    const build = async (o: xdr.Operation) =>
      new TransactionBuilder(await this.source(seqOffset), { fee: "10000", networkPassphrase: this.passphrase })
        .addOperation(o)
        .setTimeout(300)
        .build();
    let tx = await build(op);
    const sim = await simulateTransaction(this.cfg, tx.toXDR());
    if (sim.error) throw new Error(`simulation failed: ${sim.error}`);
    if (!sim.transactionData || sim.minResourceFee === undefined)
      throw new Error("simulation returned no transactionData");
    // Ops that carry no explicit auth (deploys, plain calls) use the entries the simulation recorded.
    if (!auth) {
      const recorded = (sim.results?.[0]?.auth ?? []).map((b) => xdr.SorobanAuthorizationEntry.fromXDR(b, "base64"));
      const fn = (tx.operations[0] as Operation.InvokeHostFunction).func;
      tx = await build(Operation.invokeHostFunction({ func: fn, auth: recorded }));
    }
    const assembled = TransactionBuilder.cloneFrom(tx, {
      fee: (Number(tx.fee) + Number(sim.minResourceFee)).toString(),
      sorobanData: xdr.SorobanTransactionData.fromXDR(sim.transactionData, "base64"),
    }).build();
    assembled.sign(this.fee);
    return { assembled: assembled.toXDR(), sim };
  }

  async tokenBalance(token: string, of: string): Promise<bigint> {
    const tx = new TransactionBuilder(await this.source(3), { fee: "10000", networkPassphrase: this.passphrase })
      .addOperation(new Contract(token).call("balance", addr(of)))
      .setTimeout(300)
      .build();
    const sim = await simulateTransaction(this.cfg, tx.toXDR());
    const ret = sim.results?.[0]?.xdr;
    if (sim.error || !ret) throw new Error(`balance query failed: ${sim.error ?? "no result"}`);
    const v = xdr.ScVal.fromXDR(ret, "base64").i128();
    return (BigInt(v.hi().toString()) << 64n) | BigInt(v.lo().toString());
  }

  private seqBase: bigint | undefined;

  /**
   * Fee-source account at (current ledger sequence + offset). Single-tx callers
   * (offset 0) always refetch; the batched session txs share one base so their
   * offsets 0..2 stay consistent.
   */
  private async source(offset: number): Promise<Account> {
    const g = this.fee.publicKey();
    if (this.seqBase === undefined || offset === 0) {
      const key = xdr.LedgerKey.account(
        new xdr.LedgerKeyAccount({ accountId: xdr.PublicKey.publicKeyTypeEd25519(Address.fromString(g).toBuffer()) }),
      );
      const res = await getLedgerEntries(this.cfg, [key.toXDR("base64")]);
      const entry = res.entries?.[0];
      if (!entry) throw new Error(`fee account ${g} not found — friendbot funding may have failed`);
      this.seqBase = BigInt(xdr.LedgerEntryData.fromXDR(entry.xdr, "base64").account().seqNum().toString());
    }
    return new Account(g, (this.seqBase + BigInt(offset)).toString());
  }
}

async function friendbot(g: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${g}`);
  if (!res.ok) throw new Error(`friendbot ${res.status}: ${(await res.text()).slice(0, 200)}`);
  // Give the funding tx a moment to land in the RPC's view.
  await new Promise((r) => setTimeout(r, 3000));
}

function loadWasm(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`../wasm/${name}`, import.meta.url)));
}

function addr(a: string): xdr.ScVal {
  return new Address(a).toScVal();
}

function i128(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "i128" });
}

function credential(e: xdr.SorobanAuthorizationEntry): string | undefined {
  if (e.credentials().switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) return undefined;
  return Address.fromScAddress(e.credentials().address().address()).toString();
}

function log(step: string, msg: string): void {
  console.log(`[${step}] ${msg}`);
}
