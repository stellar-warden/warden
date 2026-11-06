import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { GeneratedCrate } from "@stellar-warden/synthesizer";

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
  // Clean stale sources but keep cargo's build cache — wiping `target/`
  // recompiles soroban-sdk from scratch (minutes) on every harness run.
  if (clean) {
    const stale = (await readdir(dir).catch(() => [] as string[])).filter((name) => name !== "target");
    await Promise.all(stale.map((name) => rm(join(dir, name), { recursive: true, force: true })));
  }
  for (const [rel, content] of Object.entries(crate.files)) {
    const path = join(dir, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  await pinLockfile(dir).catch((err: Error) => {
    console.warn(`warning: could not pin ${dir}/Cargo.lock (${err.message}); cargo test may hit E0277 in soroban-env-host`);
  });
  return dir;
}

/**
 * soroban-env-host declares `ed25519-dalek = ">=2.0.0"`, an open range a
 * fresh resolve fills with 3.x — whose rand_core is incompatible with the
 * host's rand_chacha 0.3 (E0277 compiling soroban-env-host). A pin in the
 * generated manifest can't force the transitive choice, so fix the lockfile
 * itself. No-op once upstream caps the range below 3.
 */
const ED25519_DALEK_PIN = "2.2.0";

async function pinLockfile(dir: string, timeoutMs = 300_000): Promise<void> {
  const manifest = join(dir, "Cargo.toml");
  const gen = await run("cargo", ["generate-lockfile", "--manifest-path", manifest], timeoutMs);
  if (gen.code !== 0) throw new Error(`cargo generate-lockfile failed: ${gen.output.slice(-300)}`);
  const lock = await readFile(join(dir, "Cargo.lock"), "utf8");
  const versions = [...lock.matchAll(/name = "ed25519-dalek"\nversion = "([^"]+)"/g)]
    .map((m) => m[1]!)
    .filter((v) => v !== ED25519_DALEK_PIN);
  for (const v of versions) {
    const upd = await run(
      "cargo",
      ["update", "--manifest-path", manifest, "-p", `ed25519-dalek@${v}`, "--precise", ED25519_DALEK_PIN],
      timeoutMs,
    );
    if (upd.code !== 0) throw new Error(`cargo update --precise ${ED25519_DALEK_PIN} failed: ${upd.output.slice(-300)}`);
  }
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
