/**
 * Map a Codex budget snapshot onto the shared quota candidate
 * (Issues #1696, #1698, parent #1694).
 *
 * Passive snapshots come from `codex_budget.ts`. Automatic routing can also
 * read the App Server account endpoint without starting a model turn. Both
 * sources share the same parser and never invent a percentage.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import {
  type CodexBudget,
  type CodexBudgetWindow,
  parseCodexRateLimitSnapshot,
} from "./codex_budget_source.ts";
import { buildIsolatedCodexChildEnv } from "./codex_env.ts";
import type { CodexBudgetSnapshot } from "./codex_budget.ts";
import {
  type ProviderSubscriptionStatus,
  type QuotaCandidate,
  type QuotaWindow,
  subscriptionStatusFromQuotaCandidate,
} from "./provider_quota.ts";

export const CODEX_PROVIDER_ID = "codex";

function mapWindow(window: CodexBudgetWindow): QuotaWindow {
  return {
    name: window.window,
    remainingFraction: window.remainingFraction,
    resetAt: window.resetAt,
    nominalHours: window.windowMinutes === undefined
      ? undefined
      : window.windowMinutes / 60,
  };
}

/** Turn a Codex budget (known or unknown) into a shared candidate. */
export function quotaCandidateFromCodexBudget(
  label: string,
  budget: CodexBudget,
): QuotaCandidate {
  if (!budget.known) {
    return {
      providerId: CODEX_PROVIDER_ID,
      credentialLabel: label,
      budget: { known: false, reason: budget.reason },
    };
  }
  return {
    providerId: CODEX_PROVIDER_ID,
    credentialLabel: label,
    budget: { known: true, windows: budget.windows.map(mapWindow) },
  };
}

/** Same mapping from a cached adapter snapshot. */
export function quotaCandidateFromCodexSnapshot(
  label: string,
  snapshot: CodexBudgetSnapshot,
): QuotaCandidate {
  return quotaCandidateFromCodexBudget(label, snapshot.budget);
}

/**
 * Translate one cached/read-only Codex budget snapshot into the generic
 * fixed-price subscription status contract. API-key auth is explicitly
 * metered and therefore unavailable to subscription-only routing.
 */
export function subscriptionStatusFromCodexSnapshot(
  credentialLabel: string,
  snapshot: CodexBudgetSnapshot,
): ProviderSubscriptionStatus {
  const candidate = quotaCandidateFromCodexSnapshot(credentialLabel, snapshot);

  if (snapshot.authMode === "api-key") {
    return subscriptionStatusFromQuotaCandidate(
      candidate,
      snapshot.evidenceAt,
      {
        billingMode: "metered",
        confidence: "authoritative",
        reason: "api-key-account",
      },
    );
  }

  const billingMode = snapshot.authMode === "chatgpt"
    ? "fixed-subscription" as const
    : "unknown" as const;
  const confidence = snapshot.source === "exhaustion-event" ||
      snapshot.source === "rollout-token-count"
    ? "authoritative" as const
    : "inferred" as const;

  return subscriptionStatusFromQuotaCandidate(candidate, snapshot.evidenceAt, {
    billingMode,
    confidence,
    ...(snapshot.budget.known ? {} : { reason: snapshot.budget.reason }),
  });
}

/** Owned App Server process; injectable so tests never contact an account. */
export type CodexQuotaProcess =
  & Pick<Deno.ChildProcess, "stdin" | "status" | "kill">
  & { readonly stdout: ReadableStream<Uint8Array> };

export interface CodexQuotaProbeOptions {
  readonly codexHome: string;
  readonly parentEnv?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly spawn?: (options: Deno.CommandOptions) => CodexQuotaProcess;
}

/** Read subscription quota without starting a thread or model turn. */
export async function probeCodexSubscriptionQuota(
  options: CodexQuotaProbeOptions,
): Promise<CodexBudget> {
  const env = buildIsolatedCodexChildEnv(
    options.parentEnv ?? Deno.env.toObject(),
    { codexHome: options.codexHome },
  );
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  let child: CodexQuotaProcess | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    child = (options.spawn ?? ((command) =>
      new Deno.Command("codex", command).spawn()))({
        args: ["app-server"],
        cwd: options.codexHome,
        clearEnv: true,
        env,
        stdin: "piped",
        stdout: "piped",
        stderr: "null",
      });
    reader = child.stdout.getReader();
    writer = child.stdin.getWriter();
    const input = writer;
    const output = reader;
    const encoder = new TextEncoder();
    const send = (message: unknown) =>
      input.write(encoder.encode(JSON.stringify(message) + "\n"));
    const protocol = async (): Promise<CodexBudget> => {
      await send({
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "vibecoder_quota", version: "1" } },
      });
      const decoder = new TextDecoder();
      let buffer = "";
      let bytes = 0;
      let initialised = false;
      while (true) {
        const chunk = await output.read();
        if (chunk.done) {
          throw new Error("Quota stream closed");
        }
        bytes += chunk.value.byteLength;
        if (bytes > 512_000) {
          throw new Error("Quota response exceeded limit");
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) {
            continue;
          }
          const message = JSON.parse(line);
          if (!message || typeof message !== "object") {
            throw new Error("Invalid quota response");
          }
          if (message.id === 1 && !initialised) {
            if (message.error || !("result" in message)) {
              throw new Error("Quota initialisation failed");
            }
            initialised = true;
            await send({ method: "initialized" });
            await send({ id: 2, method: "account/rateLimits/read" });
          } else if (message.id === 2 && initialised) {
            if (message.error) {
              throw new Error("Quota read failed");
            }
            const result = message.result;
            const snapshot = result?.rateLimitsByLimitId !== undefined &&
                result.rateLimitsByLimitId !== null
              ? result.rateLimitsByLimitId.codex
              : result?.rateLimits;
            return parseCodexRateLimitSnapshot(snapshot);
          }
        }
      }
    };
    return await Promise.race([
      protocol(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error("Quota read timed out")),
          options.timeoutMs ?? 10_000,
        );
      }),
    ]);
  } catch {
    // Raw RPC errors may carry account information; expose only a safe code.
    return { known: false, reason: "read-error" };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (child) {
      try {
        child.kill("SIGKILL");
      } catch { /* The owned child may already have exited. */ }
      await Promise.allSettled([
        child.status,
        reader?.cancel(),
        writer?.abort(),
      ]);
    }
    reader?.releaseLock();
    writer?.releaseLock();
  }
}
