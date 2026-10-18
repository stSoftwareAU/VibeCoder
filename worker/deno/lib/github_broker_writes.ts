/**
 * Bounded ordinary REST writes; trusted lifecycle operations remain separate.
 * The broker authenticates its capability and bounds the stream before calling
 * this policy. No request field, role or supplied verdict becomes authority.
 */
import {
  classifyGhMutation,
  type MutationInfo,
} from "./audit_mutation_classifier.ts";
import { DEFAULT_CLAIMED_ISSUE_ALLOWED_VERBS } from "./claimed_issue_guard.ts";
import { CREDENTIAL_BROKER_UPSTREAMS } from "./credential_broker_policy.ts";
import { redactGhJsonBody } from "./gh_body_redaction.ts";
import { evaluateGhCommand, extractLabelValues } from "./gh_guard_decision.ts";

export interface GitHubBrokerWriteContext {
  /** Trusted host lease repositories, never a worker request field. */
  repositories: readonly string[];
  /** Trusted host claim; no configurable role or allowed lifecycle verbs. */
  claimedIssue?: { repo: string; issueNumber: number };
}

export type GitHubBrokerWriteDecision =
  | {
    allowed: true;
    upstream: URL;
    body: Uint8Array<ArrayBuffer>;
    mutation: MutationInfo;
  }
  | { allowed: false; reason: string };

type FieldKind = "text" | "labels" | "boolean";
interface WriteRoute {
  method: "POST" | "PATCH";
  path: RegExp;
  fields: Record<string, FieldKind>;
  required: readonly string[];
}

// No label replacement/removal: the broker has no provenance proving which
// existing labels this run added. State/base changes and reviews stay closed.
const routes: readonly WriteRoute[] = [
  {
    method: "POST",
    path: /^issues$/,
    fields: { title: "text", body: "text", labels: "labels" },
    required: ["title"],
  },
  {
    method: "PATCH",
    path: /^issues\/[1-9][0-9]*$/,
    fields: { title: "text", body: "text" },
    required: [],
  },
  {
    method: "POST",
    path: /^issues\/[1-9][0-9]*\/comments$/,
    fields: { body: "text" },
    required: ["body"],
  },
  {
    method: "PATCH",
    path: /^issues\/comments\/[1-9][0-9]*$/,
    fields: { body: "text" },
    required: ["body"],
  },
  {
    method: "POST",
    path: /^issues\/([1-9][0-9]*)\/labels$/,
    fields: { labels: "labels" },
    required: ["labels"],
  },
  {
    method: "POST",
    path: /^pulls$/,
    fields: {
      title: "text",
      body: "text",
      head: "text",
      base: "text",
      draft: "boolean",
    },
    required: ["title", "head", "base"],
  },
  {
    method: "PATCH",
    path: /^pulls\/[1-9][0-9]*$/,
    fields: { title: "text", body: "text" },
    required: [],
  },
];

type WriteBody = Record<string, string | boolean | string[]>;

function parseBody(
  bytes: Uint8Array,
  route: WriteRoute,
): WriteBody | undefined {
  if (bytes.byteLength > 131_072) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return;
  }
  const fields = Object.entries(parsed);
  if (fields.length === 0) return;
  for (const [key, value] of fields) {
    if (!Object.hasOwn(route.fields, key)) return;
    switch (route.fields[key]) {
      case "text":
        if (typeof value !== "string") return;
        if (key === "title" && value.trim() === "") return;
        break;
      case "boolean":
        if (typeof value !== "boolean") return;
        break;
      case "labels":
        if (!Array.isArray(value)) return;
        if (
          !value.every((label) =>
            typeof label === "string" &&
            extractLabelValues(["issue", "edit", "--add-label", label]).length >
              0
          )
        ) return;
        break;
    }
  }
  const body = parsed as WriteBody;
  for (const key of route.required) {
    const value = body[key];
    if (value === undefined) return;
    if (typeof value === "string" && value.trim() === "") return;
    if (Array.isArray(value) && value.length === 0) return;
  }
  return body;
}

function deny(reason: string): GitHubBrokerWriteDecision {
  return { allowed: false, reason: `GitHub write ${reason}` };
}

/** Return the only bytes allowed upstream; do not forward the raw request body. */
export function resolveGitHubBrokerWrite(
  request: Request,
  context: GitHubBrokerWriteContext,
  bytes: Uint8Array,
): GitHubBrokerWriteDecision {
  const url = new URL(request.url);
  if (url.search) return deny("route denied");
  const match = /^\/github\/repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(.+)$/
    .exec(url.pathname);
  if (!match) return deny("route denied");
  const repo = match[1]!;
  const resource = match[2]!;
  const route = routes.find((candidate) =>
    candidate.method === request.method && candidate.path.test(resource)
  );
  if (!route) return deny("route denied");
  const body = parseBody(bytes, route);
  if (!body) return deny("body denied");

  let canonical = JSON.stringify(body);
  try {
    // The existing helper masks publication fields and refuses secrets in
    // routing fields it cannot safely rewrite. Never publish after an error.
    canonical = redactGhJsonBody(canonical) ?? canonical;
  } catch {
    return deny("redaction failed");
  }
  const redactedBytes = new TextEncoder().encode(canonical);
  const redacted = parseBody(redactedBytes, route);
  if (!redacted) return deny("body denied");
  const endpoint = `repos/${repo}/${resource}`;
  const apiArgs = ["api", "-X", request.method, endpoint];
  for (const [key, value] of Object.entries(redacted)) {
    // The guard accepts comma-separated label values. This vector is evaluated
    // only; the typed canonical JSON above, never these strings, is forwarded.
    apiArgs.push("-f", `${key}=${value}`);
  }
  // The HTTP label subresource is not an issue-lifecycle operation. Derive its
  // equivalent edit so the existing own-claim escalation policy sees N rather
  // than treating an unrelated issue's needs-human label as unscoped.
  const labelIssue = /^issues\/([1-9][0-9]*)\/labels$/.exec(resource);
  const guardArgs = labelIssue
    ? [
      "issue",
      "edit",
      labelIssue[1]!,
      "--repo",
      repo,
      "--add-label",
      (redacted.labels as string[]).join(","),
    ]
    : apiArgs;
  const claim = context.claimedIssue;
  const decision = evaluateGhCommand(guardArgs, {
    active: true,
    allowedRepos: context.repositories,
    ...(claim
      ? {
        claimedIssue: {
          repo: claim.repo,
          issueNumber: claim.issueNumber,
          allowedVerbs: DEFAULT_CLAIMED_ISSUE_ALLOWED_VERBS,
        },
      }
      : {}),
  });
  if (!decision.allowed) return deny("policy denied");
  return {
    allowed: true,
    upstream: new URL(`/${endpoint}`, CREDENTIAL_BROKER_UPSTREAMS.github),
    body: redactedBytes,
    mutation: classifyGhMutation(apiArgs)!,
  };
}
