/**
 * blend-yield-claim example — the RFP's first walkthrough, offline.
 *
 * Builds a Recording with REAL (checksummed) generated addresses, runs the
 * pipeline (infer → codegen), and writes:
 *   - recording.json                    (fixture)
 *   - ../../contracts/generated/warden_policy_blend/   (reference crate)
 *
 * Run:  pnpm tsx examples/blend-yield-claim/make-recording.ts
 * Then: cargo test --manifest-path contracts/generated/warden_policy_blend/Cargo.toml
 *
 * On-network recording of the same shape (against mock-protocols on testnet)
 * is `warden record …` — this script exists so CI can exercise the whole
 * pipeline with zero network access.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Address, Keypair } from "@stellar/stellar-sdk";
import type { Recording } from "@stellar-warden/core";
import { explainPolicy } from "@stellar-warden/core";
import { generateCrate, inferPolicy } from "@stellar-warden/synthesizer";
import { writeCrate } from "@stellar-warden/harness";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

const contract = () => Address.contract(randomBytes(32)).toString();
const gaddr = () => Keypair.random().publicKey();

const ACCOUNT = contract();
const USDC = contract();
const POOL = contract();
const ALICE = gaddr();
const BOB = gaddr();

const recording: Recording = {
  version: 1,
  id: "blend",
  createdAt: new Date().toISOString(),
  network: { rpcUrl: "https://soroban-testnet.stellar.org", passphrase: "Test SDF Network ; September 2015" },
  account: ACCOUNT,
  label: "claim Blend-style yield, convert to payroll transfers",
  entries: [
    {
      credentialAddress: ACCOUNT,
      rootInvocation: {
        contract: POOL,
        function: "claim",
        args: [
          { kind: "address", value: ACCOUNT },
          { kind: "u32", value: 3 },
        ],
        subInvocations: [],
      },
    },
    {
      credentialAddress: ACCOUNT,
      rootInvocation: {
        contract: USDC,
        function: "transfer",
        args: [
          { kind: "address", value: ACCOUNT },
          { kind: "address", value: ALICE },
          { kind: "i128", value: "1500000000" },
        ],
        subInvocations: [],
      },
    },
    {
      credentialAddress: ACCOUNT,
      rootInvocation: {
        contract: USDC,
        function: "transfer",
        args: [
          { kind: "address", value: ACCOUNT },
          { kind: "address", value: BOB },
          { kind: "i128", value: "900000000" },
        ],
        subInvocations: [],
      },
    },
  ],
};

writeFileSync(join(here, "recording.json"), JSON.stringify(recording, null, 2));

const { spec, questions } = inferPolicy(recording, {
  kind: "ed25519-session",
  publicKeyHex: randomBytes(32).toString("hex"),
  label: "payroll-agent",
});

console.log(explainPolicy(spec));
for (const q of questions) console.log(`? [${q.ruleId} arg${q.argIndex}] ${q.question}`);

const crate = generateCrate(spec, recording, { policyCorePath: "../../policy-core" });
const dir = await writeCrate(join(root, "contracts/generated"), crate);
console.log(`\ngenerated ${crate.crateName} → ${dir}`);
console.log(`verify with: cargo test --manifest-path ${dir}/Cargo.toml`);
