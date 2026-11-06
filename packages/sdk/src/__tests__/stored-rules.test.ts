import { describe, expect, it } from "vitest";
import { parsePolicySpec, type ArgConstraint } from "@stellar-warden/core";
import { specToStoredRules, UnsupportedSpecError } from "../index.js";

const ACCOUNT = "CA6ZBKTMVZC66Q4VGGSZCCEVCPCBWNENE3H7NORVMKAJOZQSOOX2YHCU";
const TOKEN = "CAPKDPQOHT4OINMC5GPTFISNC66W3B52F6R2J6VYBAZEDN2PJHILERRX";
const ALICE = "GAGQ6KNAYXOWH64RVXV3SAJWGAHZ6WAR6B6YXDON4UEI6TWE5JPDEM7L";

const spec = (args: ArgConstraint[], extraRules: unknown[] = []) =>
  parsePolicySpec({
    version: 1,
    account: ACCOUNT,
    signer: { kind: "ed25519-session", publicKeyHex: "ab".repeat(32) },
    rules: [{ id: "transfer_1", contract: TOKEN, function: "transfer", argCount: args.length, args }, ...extraRules],
    denyUnmatched: true,
  });

describe("specToStoredRules", () => {
  it("keeps every exact/anyOf constraint an inferred transfer rule carries", () => {
    const [rule] = specToStoredRules(
      spec([
        { kind: "anyOf", argIndex: 0, values: [{ kind: "address", value: ACCOUNT }] },
        { kind: "exact", argIndex: 1, value: { kind: "address", value: ALICE } },
        { kind: "cappedSum", argIndex: 2, cap: "1500000000", window: "week" },
        { kind: "exact", argIndex: 3, value: { kind: "u32", value: 0 } },
      ]),
    );
    expect(rule!.matches).toEqual([
      { index: 0, allowed: [{ kind: "address", value: ACCOUNT }] },
      { index: 1, allowed: [{ kind: "address", value: ALICE }] },
      { index: 3, allowed: [{ kind: "u32", value: 0 }] },
    ]);
    expect(rule).toMatchObject({ arg_count: 4, cap_index: 2, cap: 1_500_000_000n, window: 604_800n });
  });

  it("leaves an uncapped rule with the no-cap sentinel", () => {
    const [rule] = specToStoredRules(spec([{ kind: "any", argIndex: 0 }]));
    expect(rule).toMatchObject({ cap_index: 0xffffffff, cap: 0n, matches: [] });
  });

  it("refuses what the account cannot enforce faithfully", () => {
    const twoCaps = spec([
      { kind: "cappedSum", argIndex: 0, cap: "1", window: "day" },
      { kind: "cappedSum", argIndex: 1, cap: "1", window: "day" },
    ]);
    expect(() => specToStoredRules(twoCaps)).toThrow(UnsupportedSpecError);

    // the account enforces the first rule for a (contract, function) — a second would be dead
    const shadowed = spec(
      [{ kind: "any", argIndex: 0 }],
      [{ id: "transfer_2", contract: TOKEN, function: "transfer", argCount: 0, args: [] }],
    );
    expect(() => specToStoredRules(shadowed)).toThrow(/second rule/);
  });
});
