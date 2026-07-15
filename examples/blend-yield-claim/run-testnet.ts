/**
 * blend-yield-claim example — LIVE testnet run.
 *
 * Same flow as make-recording.ts, but every address is a real deployed
 * contract and every step talks to Stellar testnet:
 *
 *   1. record   — live simulations of claim + payroll transfer capture the
 *                 auth entries the flow actually requires
 *   2. propose  — inferPolicy generalizes the recording (least authority)
 *   3. refine   — the documented human-review step (see REFINES below)
 *   4. synth    — generate the Rust policy crate + permit/deny matrix
 *   5. verify   — cargo test under the real soroban-sdk
 *   6. install  — owner signs add_signer; the policy is now consensus-enforced
 *   7. prove    — session key: claim ✓, transfer-within-cap ✓ (permit hashes),
 *                 then a second transfer that busts the rolling cap ✗ — a real
 *                 on-chain rejection by __check_auth (deny hash)
 *
 * Prereqs: scripts/deploy-testnet.sh (writes testnet.json), then
 *   export WARDEN_OWNER_SECRET=$(stellar keys show warden-owner)
 *   export WARDEN_SESSION_SECRET=$(stellar keys show warden-session)
 *   export WARDEN_DEPLOYER_SECRET=$(stellar keys show warden-deployer)
 *   pnpm tsx examples/blend-yield-claim/run-testnet.ts
 *
 * Writes testnet-run.json (contract IDs + tx hashes) next to this file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Account,
  Contract,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  Address,
} from "@stellar/stellar-sdk";
import { explainPolicy, parsePolicySpec, type PolicySpec, type Recording } from "@warden/core";
import {
  getLatestLedger,
  getLedgerEntries,
  recordContractCall,
  simulateTransaction,
} from "@warden/recorder";
import { generateCrate, inferPolicy } from "@warden/synthesizer";
import { runCargoTests, writeCrate } from "@warden/harness";
import {
  buildAddSignerTx,
  signSmartAccountAuthEntry,
  specToStoredRules,
  submitTx,
  TxFailedError,
} from "@warden/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const net = JSON.parse(readFileSync(join(here, "testnet.json"), "utf8")) as {
  rpcUrl: string;
  networkPassphrase: string;
  token: string;
  pool: string;
  account: string;
};
const cfg = { rpcUrl: net.rpcUrl };
const PASSPHRASE = net.networkPassphrase;

const owner = Keypair.fromSecret(need("WARDEN_OWNER_SECRET"));
const session = Keypair.fromSecret(need("WARDEN_SESSION_SECRET"));
const deployer = Keypair.fromSecret(need("WARDEN_DEPLOYER_SECRET"));
const ALICE = Keypair.random().publicKey(); // payroll recipient (fresh each run)

// Amounts (7 decimals): recorded transfer sets the weekly cap at 150 units;
// the two live transfers of 120 units then bust it on the second attempt.
const YIELD_RESERVE = 0;
const RECORDED_TRANSFER = 1_500_000_000n;
const LIVE_TRANSFER = 1_200_000_000n;

async function main(): Promise<void> {
  // -- 1. record ------------------------------------------------------------
  log("record", `live simulation: claim + transfer against ${net.pool.slice(0, 8)}…`);
  const base = {
    rpcUrl: net.rpcUrl,
    networkPassphrase: PASSPHRASE,
    source: deployer.publicKey(),
    account: net.account,
  };
  const recClaim = await recordContractCall({
    ...base,
    contract: net.pool,
    method: "claim",
    args: [
      { kind: "address", value: net.account },
      { kind: "u32", value: YIELD_RESERVE },
    ],
    label: "claim Blend-style yield",
  });
  const recPay = await recordContractCall({
    ...base,
    contract: net.token,
    method: "transfer",
    args: [
      { kind: "address", value: net.account },
      { kind: "address", value: ALICE },
      { kind: "i128", value: RECORDED_TRANSFER.toString() },
    ],
    label: "payroll transfer",
  });
  const recording: Recording = {
    version: 1,
    id: "blend_live",
    createdAt: new Date().toISOString(),
    network: { rpcUrl: net.rpcUrl, passphrase: PASSPHRASE },
    account: net.account,
    label: "claim Blend-style yield, convert to payroll transfers (LIVE)",
    entries: [...recClaim.entries, ...recPay.entries],
  };

  // -- 2. propose -----------------------------------------------------------
  const latest = await getLatestLedger(cfg);
  const { spec: draft, questions } = inferPolicy(recording, {
    kind: "ed25519-session",
    publicKeyHex: session.rawPublicKey().toString("hex"),
    expiresLedger: latest.sequence + 17_280, // ~1 day
    label: "payroll-agent",
  });
  for (const q of questions) log("propose", `? [${q.ruleId} arg${q.argIndex}] ${q.appliedDefault}`);

  // -- 3. refine (the human-review step, applied explicitly) ------------------
  // smart-account-lite's compact rules hold ONE address constraint per rule:
  //   - claim.reserve_id (u32) → any: reserve choice is not a security boundary
  //   - transfer.from → any:   from must equal the account anyway — a transfer
  //     from anyone else never routes through this account's __check_auth
  const spec = refine(draft);
  log("refine", "claim.arg1 → any (u32 reserve id); transfer.arg0 → any (require_auth-bound)");
  console.log(explainPolicy(spec));

  // -- 4+5. synth + verify ----------------------------------------------------
  const crate = generateCrate(spec, recording, { policyCorePath: "../../policy-core" });
  const dir = await writeCrate(join(root, "contracts/generated"), crate);
  log("synth", `generated ${crate.crateName}; running cargo test…`);
  const harness = await runCargoTests(dir);
  if (!harness.ok) throw new Error(`harness failed:\n${harness.output}`);
  log("verify", `HARNESS PASSED (${harness.passed} cases)`);

  // -- 6. install -------------------------------------------------------------
  const unsignedB64 = await buildAddSignerTx({
    rpcUrl: net.rpcUrl,
    networkPassphrase: PASSPHRASE,
    source: deployer.publicKey(),
    spec,
    rules: specToStoredRules(spec),
  });
  const validUntil = (await getLatestLedger(cfg)).sequence + 120; // ~10 min
  const unsigned = TransactionBuilder.fromXDR(unsignedB64, PASSPHRASE) as Transaction;
  const installOp = unsigned.operations[0] as Operation.InvokeHostFunction;
  const installAuth = (installOp.auth ?? []).map((e) =>
    credential(e) === net.account ? signSmartAccountAuthEntry(e, owner, validUntil, PASSPHRASE) : e,
  );
  const install = await submitInvoke(installOp.func, installAuth);
  log("install", `add_signer landed: ${install.hash}`);
  seqBase = undefined; // install consumed a sequence number — refetch for the session txs

  // -- 7. prove ---------------------------------------------------------------
  // Assemble all three session txs up front (the deny tx must be simulated
  // while the rolling counter is still empty — exactly what a leaked/greedy
  // session key would try), then submit in order.
  const claimTx = await prepareSessionInvoke(net.pool, "claim", [
    new Address(net.account).toScVal(),
    nativeToScVal(YIELD_RESERVE, { type: "u32" }),
  ], validUntil, 0);
  const payTx = await prepareSessionInvoke(net.token, "transfer", [
    new Address(net.account).toScVal(),
    new Address(ALICE).toScVal(),
    nativeToScVal(LIVE_TRANSFER, { type: "i128" }),
  ], validUntil, 1);
  const denyTx = await prepareSessionInvoke(net.token, "transfer", [
    new Address(net.account).toScVal(),
    new Address(ALICE).toScVal(),
    nativeToScVal(LIVE_TRANSFER, { type: "i128" }),
  ], validUntil, 2);

  const claimRes = await submitTx(cfg, claimTx);
  log("permit", `claim succeeded: ${claimRes.hash}`);
  const payRes = await submitTx(cfg, payTx);
  log("permit", `transfer 120 ≤ cap 150: ${payRes.hash}`);

  let denyHash = "";
  let denyResult = "";
  try {
    await submitTx(cfg, denyTx);
    throw new Error("DENY TX WAS ACCEPTED — policy did not hold; do not publish this run");
  } catch (err) {
    if (!(err instanceof TxFailedError)) throw err;
    denyHash = err.hash;
    denyResult = err.resultXdr ?? "";
    log("deny", `second transfer (sum 240 > cap 150) REJECTED on-chain: ${err.hash}`);
  }

  const aliceBal = await tokenBalance(ALICE);
  if (aliceBal !== LIVE_TRANSFER) throw new Error(`ALICE balance ${aliceBal} ≠ ${LIVE_TRANSFER}`);
  log("check", `ALICE received exactly ${aliceBal} (one transfer, not two)`);

  writeFileSync(
    join(here, "testnet-run.json"),
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        network: "testnet",
        contracts: { token: net.token, pool: net.pool, account: net.account },
        sessionSigner: session.publicKey(),
        payee: ALICE,
        txs: {
          install: install.hash,
          permitClaim: claimRes.hash,
          permitTransfer: payRes.hash,
          denyTransferCapExceeded: denyHash,
        },
        denyResultXdr: denyResult,
        harnessCases: harness.passed,
      },
      null,
      2,
    ),
  );
  log("done", `wrote ${join(here, "testnet-run.json")}`);
}

function refine(draft: PolicySpec): PolicySpec {
  const spec = structuredClone(draft);
  for (const rule of spec.rules) {
    if (rule.function === "claim") rule.args[1] = { kind: "any", argIndex: 1 };
    if (rule.function === "transfer") rule.args[0] = { kind: "any", argIndex: 0 };
  }
  return parsePolicySpec(spec);
}

/** Build + simulate a session-key invocation, returning the signed, submit-ready XDR. */
async function prepareSessionInvoke(
  contract: string,
  method: string,
  args: xdr.ScVal[],
  validUntil: number,
  seqOffset: number,
): Promise<string> {
  const raw = new TransactionBuilder(await feeSource(seqOffset), {
    fee: "10000",
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(new Contract(contract).call(method, ...args))
    .setTimeout(300)
    .build();
  const sim = await simulateTransaction(cfg, raw.toXDR());
  if (sim.error) throw new Error(`${method} recording simulation failed: ${sim.error}`);
  const auth = (sim.results?.[0]?.auth ?? []).map((b) => {
    const e = xdr.SorobanAuthorizationEntry.fromXDR(b, "base64");
    return credential(e) === net.account ? signSmartAccountAuthEntry(e, session, validUntil, PASSPHRASE) : e;
  });
  const op = raw.operations[0] as Operation.InvokeHostFunction;
  return assemble(op.func, auth, seqOffset);
}

async function submitInvoke(func: xdr.HostFunction, auth: xdr.SorobanAuthorizationEntry[]) {
  return submitTx(cfg, await assemble(func, auth, 0));
}

/** Simulate (enforce mode — __check_auth actually runs) and attach real resources + fee source signature. */
async function assemble(
  func: xdr.HostFunction,
  auth: xdr.SorobanAuthorizationEntry[],
  seqOffset: number,
): Promise<string> {
  const tx = new TransactionBuilder(await feeSource(seqOffset), {
    fee: "10000",
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(Operation.invokeHostFunction({ func, auth }))
    .setTimeout(300)
    .build();
  const sim = await simulateTransaction(cfg, tx.toXDR());
  if (sim.error) throw new Error(`enforce simulation failed: ${sim.error}`);
  if (!sim.transactionData || sim.minResourceFee === undefined)
    throw new Error("simulation returned no transactionData");
  const assembled = TransactionBuilder.cloneFrom(tx, {
    fee: (Number(tx.fee) + Number(sim.minResourceFee)).toString(),
    sorobanData: xdr.SorobanTransactionData.fromXDR(sim.transactionData, "base64"),
  }).build();
  assembled.sign(deployer);
  return assembled.toXDR();
}

let seqBase: bigint | undefined;
async function feeSource(offset: number): Promise<Account> {
  if (seqBase === undefined) {
    const g = deployer.publicKey();
    const key = xdr.LedgerKey.account(
      new xdr.LedgerKeyAccount({
        accountId: xdr.PublicKey.publicKeyTypeEd25519(Address.fromString(g).toBuffer()),
      }),
    );
    const res = await getLedgerEntries(cfg, [key.toXDR("base64")]);
    const entry = res.entries?.[0];
    if (!entry) throw new Error(`deployer ${g} not found — fund it via friendbot`);
    seqBase = BigInt(xdr.LedgerEntryData.fromXDR(entry.xdr, "base64").account().seqNum().toString());
  }
  return new Account(deployer.publicKey(), (seqBase + BigInt(offset)).toString());
}

function credential(e: xdr.SorobanAuthorizationEntry): string | undefined {
  if (e.credentials().switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) return undefined;
  return Address.fromScAddress(e.credentials().address().address()).toString();
}

async function tokenBalance(of: string): Promise<bigint> {
  const tx = new TransactionBuilder(await feeSource(3), { fee: "10000", networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(net.token).call("balance", new Address(of).toScVal()))
    .setTimeout(300)
    .build();
  const sim = await simulateTransaction(cfg, tx.toXDR());
  const ret = sim.results?.[0]?.xdr;
  if (sim.error || !ret) throw new Error(`balance query failed: ${sim.error ?? "no result"}`);
  const v = xdr.ScVal.fromXDR(ret, "base64").i128();
  return (BigInt(v.hi().toString()) << 64n) | BigInt(v.lo().toString());
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name} — export ${name}=$(stellar keys show <alias>)`);
  return v.trim();
}

function log(step: string, msg: string): void {
  console.log(`[${step}] ${msg}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
