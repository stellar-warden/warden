#!/usr/bin/env node
/**
 * warden CLI — same pipeline as the MCP server, for humans and CI.
 *
 *   warden demo                                        (whole loop on testnet: fresh keys, deploy, install, permit/deny)
 *   warden record   --account C.. --source G.. --contract C.. --method transfer --args '[...]' [--label s]
 *   warden propose  --recording <id> --signer <hex64> [--expires N] [--intent s] [--model]
 *   warden refine   --recording <id> --spec <edited-spec.json>
 *   warden explain  --recording <id>
 *   warden synth    --recording <id>
 *   warden test     --recording <id>
 *   warden install  --recording <id> --source G..      (prints UNSIGNED xdr)
 *   warden install  --recording <id> --submit          (owner signs + submits)
 *   warden invoke   --account C.. --contract C.. --method transfer --args '[...]'
 *                                                      (session key acts under the policy)
 *
 * Env: WARDEN_RPC_URL, WARDEN_NETWORK_PASSPHRASE, WARDEN_HOME,
 *      WARDEN_GENERATED_DIR, WARDEN_POLICY_CORE, ANTHROPIC_API_KEY (for --model)
 * Keys (S... secrets, read from env only, never from flags):
 *      WARDEN_FEE_SECRET      funded account paying fees   (install --submit, invoke)
 *      WARDEN_OWNER_SECRET    the account's owner key      (install --submit)
 *      WARDEN_SESSION_SECRET  the agent's session key      (invoke)
 */
import { runDemo } from "./demo.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  explainPolicy,
  parsePolicySpec,
  parseRecording,
  type PolicySpec,
  type ScValue,
} from "@warden/core";
import { recordContractCall } from "@warden/recorder";
import {
  anthropicChat,
  generateCrate,
  HeuristicAdvisor,
  inferPolicy,
  ModelAdvisor,
} from "@warden/synthesizer";
import { runCargoTests, writeCrate } from "@warden/harness";
import {
  buildAddSignerTx,
  buildInvokeTx,
  Keypair,
  PolicyDeniedError,
  signSmartAccountTx,
  specToStoredRules,
  submitTx,
  TxFailedError,
} from "@warden/sdk";

const HOME = resolve(process.env.WARDEN_HOME ?? ".warden");
const GENERATED = resolve(process.env.WARDEN_GENERATED_DIR ?? "contracts/generated");
// Relative to the generated crate dir (contracts/generated/<name>/), not the cwd.
const POLICY_CORE = process.env.WARDEN_POLICY_CORE ?? "../../policy-core";
const RPC = process.env.WARDEN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const PASSPHRASE = process.env.WARDEN_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case "record": {
      const recording = await recordContractCall({
        rpcUrl: RPC,
        networkPassphrase: PASSPHRASE,
        source: need(flags, "source"),
        account: need(flags, "account"),
        contract: need(flags, "contract"),
        method: need(flags, "method"),
        args: JSON.parse(need(flags, "args")) as ScValue[],
        label: flags.label,
      });
      await save("recordings", recording.id, recording);
      console.log(`recorded ${recording.id} (${recording.entries.length} auth entries)`);
      break;
    }
    case "propose": {
      const id = need(flags, "recording");
      const recording = parseRecording(await load("recordings", id));
      const { spec: draft, questions } = inferPolicy(recording, {
        kind: "ed25519-session",
        publicKeyHex: need(flags, "signer"),
        expiresLedger: flags.expires ? Number(flags.expires) : undefined,
        label: flags.label,
      });
      const advisor = "model" in flags ? new ModelAdvisor(anthropicChat()) : new HeuristicAdvisor();
      const outcome = await advisor.refine(draft, recording, flags.intent);
      await save("specs", id, outcome.spec);
      console.log(explainPolicy(outcome.spec));
      console.log(`(source: ${outcome.source})`);
      for (const q of questions) console.log(`? [${q.ruleId} arg${q.argIndex}] ${q.question}`);
      for (const w of outcome.warnings) console.log(`! ${w}`);
      break;
    }
    case "refine": {
      const id = need(flags, "recording");
      const recording = parseRecording(await load("recordings", id));
      const spec = parsePolicySpec(JSON.parse(await readFile(need(flags, "spec"), "utf8")));
      const outcome = await new HeuristicAdvisor().refine(spec, recording);
      await save("specs", id, spec);
      console.log(explainPolicy(spec));
      for (const w of outcome.warnings) console.log(`! ${w}`);
      break;
    }
    case "explain": {
      console.log(explainPolicy(await loadSpec(need(flags, "recording"))));
      break;
    }
    case "synth": {
      const id = need(flags, "recording");
      const recording = parseRecording(await load("recordings", id));
      const spec = await loadSpec(id);
      const crate = generateCrate(spec, recording, { policyCorePath: POLICY_CORE });
      const dir = await writeCrate(GENERATED, crate);
      console.log(`generated ${crate.crateName} at ${dir}`);
      console.log(crate.files["POLICY.md"]);
      break;
    }
    case "test": {
      const id = need(flags, "recording");
      const recording = parseRecording(await load("recordings", id));
      const spec = await loadSpec(id);
      const crate = generateCrate(spec, recording, { policyCorePath: POLICY_CORE });
      const dir = await writeCrate(GENERATED, crate);
      console.log(`generated ${dir}; running cargo test…`);
      const result = await runCargoTests(dir);
      console.log(result.ok ? `HARNESS PASSED (${result.passed} cases)` : `HARNESS FAILED:\n${result.output}`);
      process.exitCode = result.ok ? 0 : 1;
      break;
    }
    case "install": {
      const id = need(flags, "recording");
      const spec = await loadSpec(id);
      const submit = "submit" in flags;
      const fee = submit ? secret("WARDEN_FEE_SECRET") : undefined;
      const xdrB64 = await buildAddSignerTx({
        rpcUrl: RPC,
        networkPassphrase: PASSPHRASE,
        source: fee?.publicKey() ?? need(flags, "source"),
        spec,
        rules: specToStoredRules(spec),
      });
      if (!fee) {
        console.log("UNSIGNED install tx (sign with the OWNER key, then submit — or rerun with --submit):");
        console.log(xdrB64);
        break;
      }
      const hash = await signAndSubmit(xdrB64, spec.account, secret("WARDEN_OWNER_SECRET"), fee);
      if (hash) console.log(`policy installed on ${spec.account}: tx ${hash}`);
      break;
    }
    case "invoke": {
      const fee = secret("WARDEN_FEE_SECRET");
      const account = need(flags, "account");
      const xdrB64 = await buildInvokeTx({
        rpcUrl: RPC,
        networkPassphrase: PASSPHRASE,
        source: fee.publicKey(),
        contract: need(flags, "contract"),
        method: need(flags, "method"),
        args: JSON.parse(need(flags, "args")) as ScValue[],
      });
      const hash = await signAndSubmit(xdrB64, account, secret("WARDEN_SESSION_SECRET"), fee);
      if (hash) console.log(`PERMITTED: tx ${hash}`);
      break;
    }
    case "demo": {
      const r = await runDemo({ rpcUrl: RPC, passphrase: PASSPHRASE });
      console.log("\nwarden demo complete — policy enforced by consensus.");
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    default:
      console.log("commands: demo | record | propose | refine | explain | synth | test | install | invoke (see file header)");
      process.exitCode = cmd ? 1 : 0;
  }
}

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else out[key] = "true";
  }
  return out;
}

/** Sign as the smart account, submit, and report a policy rejection as DENIED instead of a stack trace. */
async function signAndSubmit(txB64: string, account: string, signer: Keypair, fee: Keypair): Promise<string | undefined> {
  try {
    const signed = await signSmartAccountTx({
      rpcUrl: RPC,
      networkPassphrase: PASSPHRASE,
      txB64,
      account,
      signer,
      feeSigner: fee,
    });
    return (await submitTx({ rpcUrl: RPC }, signed)).hash;
  } catch (err) {
    if (!(err instanceof PolicyDeniedError) && !(err instanceof TxFailedError)) throw err;
    console.log(`DENIED: ${err.message}`);
    process.exitCode = 2;
    return undefined;
  }
}

function secret(name: string): Keypair {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`missing env ${name} (an S... secret key)`);
    process.exit(1);
  }
  return Keypair.fromSecret(v);
}

function need(flags: Record<string, string>, key: string): string {
  const v = flags[key];
  if (!v) {
    console.error(`missing --${key}`);
    process.exit(1);
  }
  return v;
}

async function save(kind: string, id: string, data: unknown): Promise<void> {
  const dir = join(HOME, kind);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.json`), JSON.stringify(data, null, 2), "utf8");
}

async function load(kind: string, id: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(HOME, kind, `${id}.json`), "utf8"));
  } catch {
    throw new Error(`${kind}/${id} not found under ${HOME}`);
  }
}

async function loadSpec(recordingId: string): Promise<PolicySpec> {
  return parsePolicySpec(await load("specs", recordingId));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
