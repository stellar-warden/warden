import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { GeneratedCrate } from "@warden/synthesizer";

/**
 * The harness is the boundary where synthesized policies meet the real
 * enforcement semantics: it materializes the generated crate and runs its
 * permit/deny tests under the actual soroban-sdk (testutils Env), i.e. the
 * same types `__check_auth` sees on-chain.
 *
 * TS reference evaluator passing + this passing + the two agreeing on every
 * case = the differential guarantee the whole pipeline rests on.
 */

export interface HarnessResult {
  ok: boolean;
  passed: number;
  failed: number;
  crateDir: string;
  /** Raw tail of cargo output for diagnostics. */
  output: string;
  failures: string[];
}

export async function writeCrate(baseDir: string, crate: GeneratedCrate, clean = true): Promise<string> {
  const dir = resolve(baseDir, crate.crateName);
  if (clean) await rm(dir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(crate.files)) {
    const path = join(dir, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  return dir;
}

export async function runCargoTests(crateDir: string, timeoutMs = 600_000): Promise<HarnessResult> {
  const manifest = join(crateDir, "Cargo.toml");
  const { code, output } = await run("cargo", ["test", "--manifest-path", manifest, "--quiet"], timeoutMs);

  const failures = [...output.matchAll(/^test (\S+) \.\.\. FAILED$/gm)].map((m) => m[1]!);
  let passed = 0;
  let failed = 0;
  for (const m of output.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)) {
    passed += Number(m[1]);
    failed += Number(m[2]);
  }
  return {
    ok: code === 0,
    passed,
    failed,
    crateDir,
    output: output.slice(-4000),
    failures,
  };
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        reject(new Error("cargo not found — install the Rust toolchain (rustup) to run the harness"));
      else reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, output });
    });
  });
}
