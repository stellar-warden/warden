/**
 * Raw Soroban RPC client. fetch + JSON-RPC 2.0, nothing else.
 * @stellar/stellar-sdk is used in this package only for XDR construction/parsing.
 */
import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

// Node's happy-eyeballs gives each address family 250ms to connect; on a slow
// link every attempt times out and fetch dies with a bare "fetch failed".
const CONNECT_ATTEMPT_MS = 5_000;
if (getDefaultAutoSelectFamilyAttemptTimeout() < CONNECT_ATTEMPT_MS)
  setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_MS);

export interface RpcConfig {
  rpcUrl: string;
}

let nextId = 1;

export async function rpcCall<T>(cfg: RpcConfig, method: string, params: unknown): Promise<T> {
  const res = await fetch(cfg.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  }).catch((err: unknown) => {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
    throw new Error(`RPC ${method}: cannot reach ${cfg.rpcUrl} (${detail})`);
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status} from ${cfg.rpcUrl}`);
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
  if (body.error) throw new Error(`RPC ${method} error ${body.error.code}: ${body.error.message}`);
  if (body.result === undefined) throw new Error(`RPC ${method}: empty result`);
  return body.result;
}

export interface SimulateResult {
  latestLedger: number;
  results?: Array<{ auth?: string[]; xdr?: string }>;
  /** base64 SorobanTransactionData — needed to assemble an executable tx. */
  transactionData?: string;
  minResourceFee?: string;
  error?: string;
}

export function simulateTransaction(cfg: RpcConfig, txB64: string): Promise<SimulateResult> {
  return rpcCall<SimulateResult>(cfg, "simulateTransaction", { transaction: txB64 });
}

export function getLedgerEntries(
  cfg: RpcConfig,
  keysB64: string[],
): Promise<{ latestLedger: number; entries?: Array<{ key: string; xdr: string; lastModifiedLedgerSeq?: number }> }> {
  return rpcCall(cfg, "getLedgerEntries", { keys: keysB64 });
}

export function getLatestLedger(cfg: RpcConfig): Promise<{ sequence: number }> {
  return rpcCall(cfg, "getLatestLedger", {});
}

export interface SendTxResult {
  status: "PENDING" | "DUPLICATE" | "TRY_AGAIN_LATER" | "ERROR";
  hash: string;
  errorResultXdr?: string;
  diagnosticEventsXdr?: string[];
}

export function sendTransaction(cfg: RpcConfig, txB64: string): Promise<SendTxResult> {
  return rpcCall<SendTxResult>(cfg, "sendTransaction", { transaction: txB64 });
}

export interface GetTxResult {
  status: "SUCCESS" | "NOT_FOUND" | "FAILED";
  txHash?: string;
  ledger?: number;
  resultXdr?: string;
  resultMetaXdr?: string;
  diagnosticEventsXdr?: string[];
}

export function getTransaction(cfg: RpcConfig, hash: string): Promise<GetTxResult> {
  return rpcCall<GetTxResult>(cfg, "getTransaction", { hash });
}
