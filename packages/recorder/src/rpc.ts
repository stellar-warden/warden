/**
 * Raw Soroban RPC client. fetch + JSON-RPC 2.0, nothing else.
 * @stellar/stellar-sdk is used in this package only for XDR construction/parsing.
 */

export interface RpcConfig {
  rpcUrl: string;
}

let nextId = 1;

export async function rpcCall<T>(cfg: RpcConfig, method: string, params: unknown): Promise<T> {
  const res = await fetch(cfg.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
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
