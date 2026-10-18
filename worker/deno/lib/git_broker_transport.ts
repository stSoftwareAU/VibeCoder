/**
 * Fixed GitHub smart-HTTP routing and exact host-approved push transactions.
 * This pure policy does NOT validate pack objects, ancestry, authorship, quality
 * gates, lease freshness or revocation. The trusted host must do those before
 * issuing a transaction and before forwarding; worker input is never approval.
 */
import { isProtectedBranch } from "./git_branch.ts";
import { isOwnedBranch } from "./branch_history_rewrite.ts";
import { GITHUB_GIT_UPSTREAM } from "./credential_broker_policy.ts";

export interface GitBrokerContext {
  /** Host configuration and GitHub metadata, never worker origin/HEAD. */
  repositories: readonly {
    repo: string;
    defaultBranch: string;
    protectedBranches: readonly string[];
  }[];
  /**
   * Host-verified exact object transitions. A rewrite additionally requires
   * the original remote baseline and the existing ownership/author checks.
   * Never deserialise this from a worker request or accept its claimed kind.
   */
  transactions: readonly {
    repo: string;
    ref: string;
    oldOid: string;
    newOid: string;
    kind: "create" | "fast-forward" | "rewrite";
  }[];
}

export interface GitReceiveCommand {
  ref: string;
  oldOid: string;
  newOid: string;
}
export interface GitReceivePack {
  updates: GitReceiveCommand[];
  shallow: string[];
  packOffset: number;
}

const MAX_BODY = 64 * 1024 * 1024;
const ZERO_OID = "0".repeat(40);
const decoder = new TextDecoder("utf-8", { fatal: true });
const capabilities = new Set([
  "report-status",
  "report-status-v2",
  "side-band-64k",
  "quiet",
  "ofs-delta",
  "atomic",
  "object-format=sha1",
]);

function validRef(ref: string): boolean {
  const branch = ref.slice("refs/heads/".length);
  return ref.startsWith("refs/heads/") &&
    branch.length <= 255 && !branch.startsWith("-") &&
    // deno-lint-ignore no-control-regex -- Git refs cannot contain control bytes.
    !/[\x00-\x20\x7f~^:?*[\\]/.test(branch) &&
    !branch.includes("..") && !branch.includes("@{") &&
    !branch.endsWith(".") &&
    branch.split("/").every((part) =>
      part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock")
    );
}

/**
 * Inspect all SHA-1 receive-pack command packets, including shallow prefixes.
 * Push certificates, push options and unknown capabilities remain unsupported.
 * PACK bytes stay opaque: accepting this framing is not object verification.
 */
export function inspectGitReceivePack(
  bytes: Uint8Array,
): GitReceivePack | undefined {
  if (bytes.length > MAX_BODY) return;
  const updates: GitReceiveCommand[] = [];
  const shallow: string[] = [];
  let offset = 0;
  try {
    while (offset + 4 <= bytes.length) {
      const prefix = decoder.decode(bytes.subarray(offset, offset + 4));
      if (!/^[0-9a-f]{4}$/.test(prefix)) return;
      const length = Number.parseInt(prefix, 16);
      offset += 4;
      if (length === 0) {
        const pack = bytes.subarray(offset);
        if (updates.length === 0 || pack.length < 32) return;
        if (decoder.decode(pack.subarray(0, 4)) !== "PACK") return;
        const version = new DataView(pack.buffer, pack.byteOffset, 12)
          .getUint32(4);
        if (version !== 2 && version !== 3) return;
        return { updates, shallow, packOffset: offset };
      }
      if (length > 65520) {
        return;
      }
      const line = decoder.decode(bytes.subarray(offset, offset + length - 4))
        .replace(/\n$/, "");
      offset += length - 4;
      const shallowMatch = /^shallow ([0-9a-f]{40})$/.exec(line);
      if (shallowMatch) {
        const oid = shallowMatch[1]!;
        if (
          updates.length > 0 || shallow.length >= 128 || oid === ZERO_OID ||
          shallow.includes(oid)
        ) return;
        shallow.push(oid);
        continue;
      }
      if (updates.length >= 32) return;
      const match =
        /^([0-9a-f]{40}) ([0-9a-f]{40}) ([^\0\n]+)(?:\0([^\n\0]*))?$/.exec(
          line,
        );
      if (!match) return;
      const [, oldOid, newOid, ref, rawCapabilities] = match;
      if (!validRef(ref!) || updates.some((update) => update.ref === ref)) {
        return;
      }
      if (updates.length === 0) {
        if (rawCapabilities === undefined) return;
        const names = rawCapabilities.split(" ").filter(Boolean);
        if (new Set(names).size !== names.length) return;
        if (
          names.some((name) =>
            !capabilities.has(name) &&
            !/^agent=[A-Za-z0-9_./-]{1,128}$/.test(name)
          )
        ) return;
      } else if (rawCapabilities !== undefined) return;
      updates.push({ ref: ref!, oldOid: oldOid!, newOid: newOid! });
    }
  } catch {
    // Invalid UTF-8 and truncated packets produce a scrubbed denial.
  }
  return undefined;
}

export type GitBrokerDecision =
  | { allowed: false; reason: string }
  | {
    allowed: true;
    upstream: URL;
    /** The complete safe header set, before host credential injection. */
    headers: Headers;
    /** A snapshot: the caller must forward these exact checked bytes. */
    body: Uint8Array<ArrayBuffer>;
    kind: "discovery" | "fetch" | "push";
    /** Journal every transition, not just the last ref of a multi-ref push. */
    updates: GitReceiveCommand[];
  };

/** Resolve only smart HTTP; no dumb objects, LFS, SSH, redirects or arbitrary RPC. */
export function resolveGitBrokerRequest(
  request: Request,
  context: GitBrokerContext,
  bytes = new Uint8Array(),
): GitBrokerDecision {
  const denied: GitBrokerDecision = {
    allowed: false,
    reason: "Git broker request denied",
  };
  const url = new URL(request.url);
  const route =
    /^\/git\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/
      .exec(url.pathname);
  if (!route || url.hash || bytes.length > MAX_BODY) return denied;
  const repo = route[1]!.toLowerCase();
  const repository = context.repositories.find((entry) =>
    entry.repo.toLowerCase() === repo
  );
  if (!repository) return denied;
  if (request.headers.has("content-encoding")) return denied;
  const protocol = request.headers.get("git-protocol");
  if (protocol !== null && !["version=1", "version=2"].includes(protocol)) {
    return denied;
  }
  const headers = new Headers();
  if (protocol !== null) headers.set("git-protocol", protocol);
  const endpoint = route[2]!;
  let kind: "discovery" | "fetch" | "push";
  let updates: GitReceiveCommand[] = [];
  if (endpoint === "info/refs") {
    if (request.method !== "GET" || bytes.length !== 0) return denied;
    if (!/^\?service=git-(?:upload|receive)-pack$/.test(url.search)) {
      return denied;
    }
    kind = "discovery";
  } else {
    if (request.method !== "POST" || url.search) return denied;
    const contentType = `application/x-${endpoint}-request`;
    if (request.headers.get("content-type") !== contentType) return denied;
    headers.set("content-type", contentType);
    kind = endpoint === "git-upload-pack" ? "fetch" : "push";
    if (kind === "push") {
      const parsed = inspectGitReceivePack(bytes);
      if (!parsed || !repository.defaultBranch) return denied;
      updates = parsed.updates;
      for (const update of updates) {
        const branch = update.ref.slice("refs/heads/".length);
        if (
          branch === repository.defaultBranch || update.newOid === ZERO_OID ||
          update.oldOid === update.newOid
        ) return denied;
        const transaction = context.transactions.find((entry) =>
          entry.repo.toLowerCase() === repo && entry.ref === update.ref &&
          entry.oldOid === update.oldOid && entry.newOid === update.newOid
        );
        if (!transaction) return denied;
        if (update.oldOid === ZERO_OID) {
          if (transaction.kind !== "create") return denied;
        } else if (transaction.kind === "rewrite") {
          if (
            isProtectedBranch(branch) ||
            repository.protectedBranches.includes(branch) ||
            !isOwnedBranch(branch, repository.defaultBranch)
          ) return denied;
        } else if (transaction.kind !== "fast-forward") return denied;
      }
    }
  }
  return {
    allowed: true,
    upstream: new URL(
      `/${repo}.git/${endpoint}${url.search}`,
      GITHUB_GIT_UPSTREAM,
    ),
    headers,
    body: bytes.slice(),
    kind,
    updates,
  };
}
