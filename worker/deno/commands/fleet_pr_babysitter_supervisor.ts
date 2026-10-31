/** Run a babysitter pass with private, compressed, bounded logs and an optional health hook. */
import {
  runWithTimeout,
  spawnCommandWithTimeout,
} from "../lib/subprocess_timeout.ts";
import { installConsoleRedaction } from "../lib/console_redaction.ts";

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const KEEP_LOGS = 30;

/** Remove only completed babysitter archives, keeping the newest. */
export async function pruneLogs(dir: string, keep = KEEP_LOGS): Promise<void> {
  const entries: { path: string; time: number }[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !/^pass-.*\.log\.gz$/.test(entry.name)) continue;
    const path = `${dir}/${entry.name}`;
    const info = await Deno.stat(path);
    entries.push({ path, time: info.mtime?.getTime() ?? 0 });
  }
  entries.sort((a, b) => b.time - a.time || b.path.localeCompare(a.path));
  for (const entry of entries.slice(keep)) {
    try {
      await Deno.remove(entry.path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
}

async function compress(path: string): Promise<void> {
  const archive = `${path}.gz`;
  const temporary = `${archive}.${Deno.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const source = await Deno.open(path, { read: true });
    const target = await Deno.open(temporary, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    await source.readable.pipeThrough(new CompressionStream("gzip")).pipeTo(
      target.writable,
    );
    await Deno.rename(temporary, archive);
    try {
      await Deno.remove(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  } catch (error) {
    try {
      await Deno.remove(temporary);
    } catch { /* no partial archive */ }
    throw error;
  }
}

/** Recover interrupted passes while leaving logs of living processes alone. */
export async function recoverLogs(dir: string): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile) continue;
    const partial = /^pass-\d+-.*\.log\.gz\.(\d+)\.[^.]+\.tmp$/.exec(
      entry.name,
    );
    const match = partial ?? /^pass-(\d+)-.*\.log$/.exec(entry.name);
    if (!match) continue;
    const probe = await runWithTimeout("/bin/kill", ["-0", match[1]!], {
      timeoutMs: 10_000,
    });
    if (!probe.ok) throw probe.error;
    if (probe.value.timedOut) {
      throw new Error("Process liveness probe timed out");
    }
    if (probe.value.success) continue;
    try {
      if (partial) await Deno.remove(`${dir}/${entry.name}`);
      else await compress(`${dir}/${entry.name}`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  await pruneLogs(dir);
}

async function pass(args: string[], dir: string): Promise<number> {
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await recoverLogs(dir);
  } catch (error) {
    console.error(`Could not recover previous logs: ${error}`);
  }
  const name = `pass-${Deno.pid}-${
    new Date().toISOString().replaceAll(":", "-")
  }-${crypto.randomUUID()}.log`;
  const path = `${dir}/${name}`;
  const file = await Deno.open(path, {
    createNew: true,
    write: true,
    mode: 0o600,
  });
  let bytes = 0;
  let truncated = false;
  const write = async (chunk: Uint8Array): Promise<void> => {
    const part = chunk.subarray(0, Math.max(0, MAX_LOG_BYTES - bytes));
    if (part.length) {
      await file.write(part);
      bytes += part.length;
    }
    if (part.length < chunk.length && !truncated) {
      truncated = true;
      await file.write(
        new TextEncoder().encode("\n[log truncated at 10 MiB]\n"),
      );
    }
  };
  let code = 1;
  try {
    const child = spawnCommandWithTimeout(Deno.execPath(), {
      timeoutMs: 24 * 60 * 60_000,
      args: [
        "run",
        "--allow-all",
        "worker/deno/commands/fleet_pr_babysitter.ts",
        ...args,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    // Serialise writes to the single log while continuing to drain both pipes.
    let pending = Promise.resolve();
    const copy = async (
      stream: ReadableStream<Uint8Array>,
      out: { write(data: Uint8Array): Promise<number> },
    ) => {
      for await (const chunk of stream) {
        await out.write(chunk);
        pending = pending.then(() => write(chunk));
        await pending;
      }
    };
    await Promise.all([
      copy(child.stdout, Deno.stdout),
      copy(child.stderr, Deno.stderr),
    ]);
    code = (await child.status).code;
  } catch (error) {
    const message = `Babysitter supervisor error: ${error}\n`;
    await write(new TextEncoder().encode(message));
    console.error(message);
  }
  try {
    const hook = `${
      Deno.env.get("HOME")
    }/.vibe-coder/fleet-pr-babysitter/health-hook`;
    try {
      if (
        args.some((arg) =>
          arg === "--dry-run" || arg.startsWith("--repo=") ||
          arg.startsWith("--pr=")
        )
      ) {
        throw new Deno.errors.NotFound(
          "A partial or dry run does not report service health",
        );
      }
      await Deno.stat(hook);
      const result = await runWithTimeout(hook, [String(code)], {
        timeoutMs: 600_000,
      });
      if (!result.ok || !result.value.success) {
        await write(
          new TextEncoder().encode(
            "Health hook failed; it will be retried on the next pass.\n",
          ),
        );
        if (result.ok) {
          await write(
            new TextEncoder().encode(
              (result.value.stderr || result.value.stdout).slice(-4000),
            ),
          );
        }
        console.error(
          "Health hook failed; see the hook configuration and retry on the next pass.",
        );
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  } catch (error) {
    const message = `Health hook error: ${error}\n`;
    await write(new TextEncoder().encode(message));
    console.error(message);
  } finally {
    file.close();
  }
  // Keep the original if compression fails; a partial archive is never retained.
  try {
    await compress(path);
    await pruneLogs(dir);
  } catch (error) {
    console.error(`Log compression or retention failed for ${path}: ${error}`);
    code = 1;
  }
  return code;
}

if (import.meta.main) {
  installConsoleRedaction();
  const home = Deno.env.get("HOME");
  if (!home) throw new Error("HOME is not set");
  const watch = Deno.args.includes("--watch");
  const args = Deno.args.filter((arg) => arg !== "--watch");
  do {
    Deno.exitCode = await pass(
      args,
      `${home}/.vibe-coder/fleet-pr-babysitter/logs`,
    );
    if (watch) await new Promise((resolve) => setTimeout(resolve, 300_000));
  } while (watch);
}
