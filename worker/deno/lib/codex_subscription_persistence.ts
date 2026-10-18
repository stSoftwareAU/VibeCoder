/** Host-only, same-filesystem Codex account transaction and persistence. */
import { dirname, isAbsolute, normalize } from "node:path";
import { withFileLock } from "./file_lock.ts";
import { atomicWriteSync, readTextFileNoFollow } from "./file_utils.ts";
import {
  assertCodexSubscriptionSnapshot,
  type CodexSubscriptionPersist,
  type CodexSubscriptionTransaction,
} from "./codex_subscription_transport.ts";

/**
 * Use a canonical absolute path in a host-owned private directory. Every broker
 * sharing this account must use this transaction, including across processes.
 * The agent has neither this path nor an RPC that calls the writer directly.
 */
export function createCodexSubscriptionPersistence(options: {
  authFile: string;
  accountId: string;
}): {
  persist: CodexSubscriptionPersist;
  transaction: CodexSubscriptionTransaction;
} {
  const { authFile, accountId } = options;
  const directory = dirname(authFile);
  const lockPath = `${authFile}.broker-lock`;
  if (!isAbsolute(authFile) || normalize(authFile) !== authFile) {
    throw new Error("Codex auth path must be canonical and absolute");
  }

  function checkDirectory(): void {
    const info = Deno.lstatSync(directory);
    if (
      !info.isDirectory || info.isSymlink ||
      Deno.realPathSync(directory) !== directory ||
      info.mode === null || (info.mode & 0o077) !== 0
    ) throw new Error("Codex auth directory must be private and canonical");
  }

  function checkFile(): void {
    checkDirectory();
    const info = Deno.lstatSync(authFile);
    if (
      !info.isFile || info.isSymlink || info.nlink !== 1 ||
      info.size > 128 * 1024
    ) {
      throw new Error(
        "Codex auth file must be a bounded singly linked regular file",
      );
    }
  }

  async function read(): Promise<string> {
    checkFile();
    const result = await readTextFileNoFollow(authFile);
    if (!result.ok || result.value === null) {
      throw new Error("Codex auth file could not be read safely");
    }
    assertCodexSubscriptionSnapshot(result.value, accountId);
    return result.value;
  }

  const transaction: CodexSubscriptionTransaction = async ({ signal, run }) => {
    signal.throwIfAborted();
    checkDirectory();
    try {
      if (Deno.lstatSync(lockPath).isSymlink) {
        throw new Error("Codex auth lock must not be a symlink");
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    return await withFileLock(lockPath, async () => {
      bounded.throwIfAborted();
      const initial = await read();
      let active = true;
      let writing = false;
      const commit: CodexSubscriptionPersist = async (replacement) => {
        function live(): void {
          if (!active) throw new Error("Codex auth transaction is closed");
          bounded.throwIfAborted();
          replacement.signal.throwIfAborted();
        }
        live();
        if (writing) throw new Error("Codex auth transaction already wrote");
        writing = true;
        const current = await read();
        if (current !== replacement.expectedAuthJson) {
          throw new Error("Codex auth snapshot changed");
        }
        assertCodexSubscriptionSnapshot(replacement.authJson, accountId);
        const value = JSON.parse(current);
        const rotated = JSON.parse(replacement.authJson);
        // Only the fields owned by OAuth rotation change. Preserve future and
        // operator metadata, including unrelated fields within `tokens`.
        Object.assign(value.tokens, {
          access_token: rotated.tokens.access_token,
          refresh_token: rotated.tokens.refresh_token,
          id_token: rotated.tokens.id_token,
        });
        value.last_refresh = rotated.last_refresh;
        const merged = JSON.stringify(value);
        assertCodexSubscriptionSnapshot(merged, accountId);
        checkFile();
        // No await between the final abort check and the atomic rename: a close
        // callback cannot run in the middle and publish a cancelled rotation.
        live();
        const written = atomicWriteSync({
          targetFile: authFile,
          content: merged,
          mode: 0o600,
        });
        if (!written.ok) {
          throw new Error("Codex auth atomic replacement failed");
        }
        // Success is durable before the transport publishes the replacement.
        // A sync failure after rename is still a failure and closes transport.
        for (const path of [authFile, directory]) {
          const file = Deno.openSync(path, { read: true });
          try {
            file.syncSync();
          } finally {
            file.close();
          }
        }
        return merged;
      };
      const aborted = Promise.withResolvers<never>();
      const onAbort = () => aborted.reject(bounded.reason);
      bounded.addEventListener("abort", onAbort, { once: true });
      try {
        bounded.throwIfAborted();
        return await Promise.race([run(initial, commit), aborted.promise]);
      } finally {
        active = false;
        bounded.removeEventListener("abort", onAbort);
      }
    });
  };

  const persist: CodexSubscriptionPersist = (replacement) =>
    transaction({
      signal: replacement.signal,
      run: async (_current, commit) => (await commit(replacement))!,
    });
  return { persist, transaction };
}
