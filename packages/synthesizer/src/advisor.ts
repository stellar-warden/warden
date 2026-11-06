import {
  parsePolicySpec,
  PolicySpecError,
  type PolicySpec,
  type Recording,
} from "@stellar-warden/core";
import { evalEntry, newState } from "./eval.js";

/**
 * The advisor is where a model is ALLOWED to participate — under guard.
 *
 * Loop (plan → act → verify → repair, same discipline as a verify-gated
 * agent harness):
 *   1. model receives the draft spec, the recording facts, and the user's
 *      stated intent, and proposes a full replacement spec — JSON only
 *   2. schema gate: parsePolicySpec (zod). Failure text is fed back, retry.
 *   3. semantic gate: the reference evaluator replays the recording against
 *      the proposed spec; any recorded flow the proposal would DENY is
 *      surfaced as a warning (narrowing is legal, but never silent).
 *   4. after `maxAttempts` failures the heuristic draft stands. The model is
 *      advisory; determinism wins ties.
 *
 * No model output ever flows to codegen directly — only a spec that survived
 * the gates.
 */

export interface AdvisorOutcome {
  spec: PolicySpec;
  source: "heuristic" | "model";
  rationale?: string;
  warnings: string[];
  attempts: number;
}

export interface Advisor {
  refine(draft: PolicySpec, recording: Recording, userIntent?: string): Promise<AdvisorOutcome>;
}

export class HeuristicAdvisor implements Advisor {
  async refine(draft: PolicySpec, recording: Recording): Promise<AdvisorOutcome> {
    return { spec: draft, source: "heuristic", warnings: verifyAgainstRecording(draft, recording), attempts: 0 };
  }
}

export interface ChatFn {
  (system: string, user: string): Promise<string>;
}

export class ModelAdvisor implements Advisor {
  constructor(
    private readonly chat: ChatFn,
    private readonly maxAttempts = 3,
  ) {}

  async refine(draft: PolicySpec, recording: Recording, userIntent?: string): Promise<AdvisorOutcome> {
    const system = SYSTEM_PROMPT;
    let user = buildUserPrompt(draft, recording, userIntent);

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const raw = await this.chat(system, user);
      try {
        const proposed = parsePolicySpec(extractJson(raw));
        enforceInvariants(draft, proposed);
        return {
          spec: proposed,
          source: "model",
          warnings: verifyAgainstRecording(proposed, recording),
          attempts: attempt,
        };
      } catch (err) {
        const issues = err instanceof PolicySpecError ? err.issues : String(err instanceof Error ? err.message : err);
        user = `${user}\n\nYour previous output was rejected by the validator:\n${issues}\nOutput ONLY corrected JSON.`;
      }
    }
    return {
      spec: draft,
      source: "heuristic",
      rationale: `model failed validation ${this.maxAttempts} times; heuristic draft retained`,
      warnings: verifyAgainstRecording(draft, recording),
      attempts: this.maxAttempts,
    };
  }
}

/** Default ChatFn against the Anthropic Messages API (bring your own key). */
export function anthropicChat(opts: { apiKey?: string; model?: string; baseUrl?: string } = {}): ChatFn {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const model = opts.model ?? process.env.WARDEN_MODEL ?? "claude-sonnet-4-6";
  const baseUrl = opts.baseUrl ?? "https://api.anthropic.com";
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set — use HeuristicAdvisor or provide a key");
  return async (system, user) => {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 4000, system, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = body.content
      ?.filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    if (!text) throw new Error("Anthropic API returned no text content");
    return text;
  };
}

// ---------------------------------------------------------------------------

/** Invariants a refinement may never change, regardless of what it argues. */
function enforceInvariants(draft: PolicySpec, proposed: PolicySpec): void {
  if (proposed.account !== draft.account) throw new Error("refinement changed the governed account");
  if (proposed.signer.publicKeyHex !== draft.signer.publicKeyHex)
    throw new Error("refinement changed the signer public key");
  const draftTargets = new Set(draft.rules.map((r) => `${r.contract}::${r.function}`));
  for (const r of proposed.rules) {
    if (!draftTargets.has(`${r.contract}::${r.function}`))
      throw new Error(
        `refinement introduced a call target not present in the recording: ${r.contract.slice(0, 6)}…::${r.function}`,
      );
  }
}

/** Replay every recorded entry through the reference evaluator; report denials as warnings. */
function verifyAgainstRecording(spec: PolicySpec, recording: Recording): string[] {
  const warnings: string[] = [];
  const state = newState(1_000_000);
  recording.entries.forEach((entry, i) => {
    const v = evalEntry(spec, entry, state);
    if (!v.ok) warnings.push(`recorded entry #${i + 1} would now be DENIED: ${v.reason}`);
  });
  return warnings;
}

function extractJson(raw: string): unknown {
  const stripped = raw.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object found in model output");
  return JSON.parse(stripped.slice(start, end + 1));
}

const SYSTEM_PROMPT = `You refine PolicySpec JSON for Soroban smart-account authorization policies.
Rules you must obey:
- Output ONLY a single JSON object conforming to the PolicySpec schema. No prose, no markdown.
- Least authority: never widen beyond what the recording demonstrates and the user explicitly asks for.
- You may NOT add new (contract, function) targets, change the account, or change the signer key.
- denyUnmatched is always true. Every argIndex must have an explicit constraint ('any' if truly unconstrained).
- Prefer cappedSum for amounts, anyOf allowlists for addresses, exact for everything else.`;

function buildUserPrompt(draft: PolicySpec, recording: Recording, userIntent?: string): string {
  return [
    `Recorded facts (ground truth):`,
    JSON.stringify(recording, null, 2),
    ``,
    `Current draft spec:`,
    JSON.stringify(draft, null, 2),
    ``,
    userIntent ? `User intent: ${userIntent}` : `User intent: (none stated — keep defaults, tighten where obvious)`,
    ``,
    `Return the full refined PolicySpec JSON.`,
  ].join("\n");
}
