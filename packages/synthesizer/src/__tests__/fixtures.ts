import type { Recording, Signer } from "@stellar-warden/core";

/** Synthetic strkey (charset-valid; TS-side tests never checksum). */
export const acct = (c: string) => `C${c.repeat(55)}`;
export const gaddr = (c: string) => `G${c.repeat(55)}`;

export const ACCOUNT = acct("A");
export const USDC = acct("B");
export const BLEND = acct("D");
export const ALICE = gaddr("E");
export const BOB = gaddr("F");

export const SIGNER: Signer = {
  kind: "ed25519-session",
  publicKeyHex: "ab".repeat(32),
  label: "payroll-agent",
};

/** A two-entry recording: claim yield on a pool, then pay two contributors. */
export function payrollRecording(): Recording {
  return {
    version: 1,
    id: "rec-test-payroll",
    createdAt: "2026-07-09T00:00:00.000Z",
    network: { rpcUrl: "https://soroban-testnet.stellar.org", passphrase: "Test SDF Network ; September 2015" },
    account: ACCOUNT,
    label: "monthly payroll",
    entries: [
      {
        credentialAddress: ACCOUNT,
        rootInvocation: {
          contract: BLEND,
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
}
