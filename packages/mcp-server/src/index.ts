#!/usr/bin/env node
/**
 * warden MCP server — the conversational front door.
 *
 * Connect this to Claude (or any MCP client) and the record→propose→refine→
 * synthesize→verify→install loop becomes a conversation. The model NEVER
 * holds authority here: every tool output the model can influence passes the
 * same schema + evaluator gates as the CLI path, and installation always
 * returns an UNSIGNED transaction for the human owner's key.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  explainPolicy,
  parsePolicySpec,
  parseRecording,
  type PolicySpec,
  type Recording,
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
import { buildAddSignerTx, specToStoredRules } from "@warden/sdk";

const HOME = resolve(process.env.WARDEN_HOME ?? ".warden");
const GENERATED = resolve(process.env.WARDEN_GENERATED_DIR ?? "contracts/generated");
const POLICY_CORE = process.env.WARDEN_POLICY_CORE ?? "../../contracts/policy-core";
const RPC = process.env.WARDEN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const PASSPHRASE = process.env.WARDEN_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";

const server = new McpServer({ name: "warden", version: "0.1.0" });

const scValueShape = z.object({ kind: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) });

server.registerTool(
  "record_flow",
  {
    title: "Record a transaction flow",
    description:
      "Simulate a Soroban contract call and record the authorization it requires. Returns a recording id used by every other tool. Args are typed ScValues, e.g. [{kind:'address',value:'G...'},{kind:'i128',value:'1500000000'}].",
    inputSchema: {
      account: z.string().describe("The smart account (C-address) being governed"),
      source: z.string().describe("Funded G-address used as simulation fee source"),
      contract: z.string().describe("Target contract (C-address)"),
      method: z.string().describe("Function to call"),
      args: z.array(scValueShape).describe("Typed arguments"),
      label: z.string().optional(),
    },
  },
  async ({ account, source, contract, method, args, label }) => {
    const recording = await recordContractCall({
      rpcUrl: RPC,
      networkPassphrase: PASSPHRASE,
      source,
      account,
      contract,
      method,
      args: args as never,
      label,
    });
    await save("recordings", recording.id, recording);
    const calls = recording.entries.length;
    return text(
      `Recorded ${recording.id} (${calls} auth entr${calls === 1 ? "y" : "ies"}).\n` +
        `Next: propose_policy with recordingId="${recording.id}" and the agent's session public key.`,
    );
  },
);

server.registerTool(
  "propose_policy",
  {
    title: "Propose a policy from a recording",
    description:
      "Infer a least-authority PolicySpec draft from a recording. Optionally refine it with a model (requires ANTHROPIC_API_KEY); the refinement is schema-gated and replayed against the recording. Returns the spec, plain-English explanation, and open questions.",
    inputSchema: {
      recordingId: z.string(),
      signerPublicKeyHex: z.string().regex(/^[0-9a-f]{64}$/),
      signerLabel: z.string().optional(),
      expiresLedger: z.number().int().positive().optional(),
      intent: z.string().optional().describe("What the user says this agent should be allowed to do"),
      useModel: z.boolean().optional().describe("Refine with an LLM advisor (default false)"),
    },
  },
  async ({ recordingId, signerPublicKeyHex, signerLabel, expiresLedger, intent, useModel }) => {
    const recording = parseRecording(await load("recordings", recordingId));
    const { spec: draft, questions } = inferPolicy(recording, {
      kind: "ed25519-session",
      publicKeyHex: signerPublicKeyHex,
      label: signerLabel,
      expiresLedger,
    });
    const advisor = useModel ? new ModelAdvisor(anthropicChat()) : new HeuristicAdvisor();
    const outcome = await advisor.refine(draft, recording, intent);
    await save("specs", recordingId, outcome.spec);
    const qs = questions.length
      ? `\nOpen questions (defaults applied):\n${questions.map((q) => `- [${q.ruleId} arg${q.argIndex}] ${q.question}`).join("\n")}`
      : "";
    const warns = outcome.warnings.length ? `\nWARNINGS:\n${outcome.warnings.map((w) => `- ${w}`).join("\n")}` : "";
    return text(
      `${explainPolicy(outcome.spec)}\n(source: ${outcome.source})${qs}${warns}\n\n` +
        `Adjust with refine_policy, or continue to synthesize_rust.`,
    );
  },
);

server.registerTool(
  "refine_policy",
  {
    title: "Apply an edited PolicySpec",
    description:
      "Replace the stored spec for a recording with an edited one. The spec is schema-validated and replayed against the recording; denials of the recorded flow are surfaced as warnings.",
    inputSchema: { recordingId: z.string(), spec: z.record(z.unknown()).describe("Full PolicySpec JSON") },
  },
  async ({ recordingId, spec }) => {
    const recording = parseRecording(await load("recordings", recordingId));
    const parsed = parsePolicySpec(spec);
    const { HeuristicAdvisor: H } = await import("@warden/synthesizer");
    const outcome = await new H().refine(parsed, recording);
    await save("specs", recordingId, parsed);
    const warns = outcome.warnings.length ? `\nWARNINGS:\n${outcome.warnings.join("\n")}` : "";
    return text(`Spec updated.\n${explainPolicy(parsed)}${warns}`);
  },
);

server.registerTool(
  "explain_policy",
  {
    title: "Explain the current policy in plain English",
    description: "Deterministic English rendering of the stored PolicySpec for a recording. No model involved.",
    inputSchema: { recordingId: z.string() },
  },
  async ({ recordingId }) => text(explainPolicy(await loadSpec(recordingId))),
);

server.registerTool(
  "synthesize_rust",
  {
    title: "Synthesize the Rust policy crate",
    description:
      "Deterministically generate the Rust enforcement crate (enforce fn + permit/deny test suite) from the stored spec and recording. Writes it under the generated dir and returns the verification matrix.",
    inputSchema: { recordingId: z.string() },
  },
  async ({ recordingId }) => {
    const recording = parseRecording(await load("recordings", recordingId));
    const spec = await loadSpec(recordingId);
    const crate = generateCrate(spec, recording, { policyCorePath: POLICY_CORE });
    const dir = await writeCrate(GENERATED, crate);
    return text(`Generated ${crate.crateName} at ${dir}\n\n${crate.files["POLICY.md"]}`);
  },
);

server.registerTool(
  "run_harness",
  {
    title: "Run the permit/deny harness",
    description:
      "Runs `cargo test` on the generated crate — the generated policy is executed under the real soroban-sdk against every permit and deny case. Requires a Rust toolchain.",
    inputSchema: { recordingId: z.string() },
  },
  async ({ recordingId }) => {
    const recording = parseRecording(await load("recordings", recordingId));
    const spec = await loadSpec(recordingId);
    const crate = generateCrate(spec, recording, { policyCorePath: POLICY_CORE });
    const dir = await writeCrate(GENERATED, crate);
    const result = await runCargoTests(dir);
    if (result.ok) return text(`HARNESS PASSED: ${result.passed} cases (permit + deny) verified in ${dir}.`);
    return text(
      `HARNESS FAILED: ${result.failed} failing case(s): ${result.failures.join(", ")}\n\n${result.output}`,
    );
  },
);

server.registerTool(
  "build_install_tx",
  {
    title: "Build the (unsigned) install transaction",
    description:
      "Builds the unsigned transaction that registers the session signer + compact rules on the smart-account-lite contract. Returns base64 XDR for the OWNER to review and sign out-of-band — this tool never signs.",
    inputSchema: { recordingId: z.string(), source: z.string().describe("Funded G-address paying fees") },
  },
  async ({ recordingId, source }) => {
    const spec = await loadSpec(recordingId);
    const rules = specToStoredRules(spec);
    const xdrB64 = await buildAddSignerTx({
      rpcUrl: RPC,
      networkPassphrase: PASSPHRASE,
      source,
      spec,
      rules,
    });
    return text(
      `Unsigned install transaction (add_signer on ${spec.account}):\n${xdrB64}\n\n` +
        `Review with explain_policy, then sign with the OWNER key (e.g. stellar-cli) and submit. warden never holds keys.`,
    );
  },
);

// ---------------------------------------------------------------------------

async function save(kind: string, id: string, data: unknown): Promise<void> {
  const dir = join(HOME, kind);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.json`), JSON.stringify(data, null, 2), "utf8");
}

async function load(kind: string, id: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(HOME, kind, `${id}.json`), "utf8"));
  } catch {
    throw new Error(`${kind}/${id} not found under ${HOME} — run the earlier pipeline step first`);
  }
}

async function loadSpec(recordingId: string): Promise<PolicySpec> {
  return parsePolicySpec(await load("specs", recordingId));
}

function text(t: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: t }] };
}

const transport = new StdioServerTransport();
await server.connect(transport);
