/**
 * Egress allowlist (Issue #4045): the single list of hosts the container may
 * reach. GitHub and the package registries are always on; agent-provider
 * hosts follow the enabled providers; the imgbb host follows imgbb being
 * configured; the ANTHROPIC_BASE_URL host and operator `egress_allow_hosts`
 * extras are appended last.
 *
 * #4046 (CONNECT egress proxy) will enforce this list. Today `loadConfig`
 * validates `egress_allow_hosts` and nothing else reads the list yet.
 *
 * Australian English spelling throughout (normalised, behaviour).
 */

import {
  CLAUDE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  DEEPSEEK_PROVIDER_ID,
  GEMINI_PROVIDER_ID,
} from "./agent_provider.ts";
import { DEEPSEEK_ANTHROPIC_BASE_URL } from "./deepseek_env.ts";

/** Why a host is on the list. */
export type EgressPurpose = "github" | "agent-provider" | "imgbb" | "registry";

/** One host the container may reach, with its purpose. */
export interface EgressHostRule {
  readonly host: string;
  readonly purpose: EgressPurpose;
  readonly reason: string;
  readonly provider?: string;
}

const DEEPSEEK_HOST = new URL(DEEPSEEK_ANTHROPIC_BASE_URL).hostname;

/** GitHub (the control plane) and the package registries, always on. */
export const BUILTIN_EGRESS_RULES: readonly EgressHostRule[] = [
  // GitHub
  {
    host: "github.com",
    purpose: "github",
    reason: "git transport and web",
  },
  {
    host: "api.github.com",
    purpose: "github",
    reason: "REST and GraphQL API",
  },
  {
    host: "uploads.github.com",
    purpose: "github",
    reason: "release asset uploads",
  },
  {
    host: "codeload.github.com",
    purpose: "github",
    reason: "archive tarball downloads",
  },
  {
    host: "objects.githubusercontent.com",
    purpose: "github",
    reason: "release asset and attachment downloads",
  },
  {
    host: "raw.githubusercontent.com",
    purpose: "github",
    reason: "raw file downloads",
  },
  // Package registries
  {
    host: "registry.npmjs.org",
    purpose: "registry",
    reason: "npm packages",
  },
  {
    host: "jsr.io",
    purpose: "registry",
    reason: "JSR packages",
  },
  {
    host: "deno.land",
    purpose: "registry",
    reason: "Deno standard library and third-party modules",
  },
  {
    host: "crates.io",
    purpose: "registry",
    reason: "Rust crate index API",
  },
  {
    host: "index.crates.io",
    purpose: "registry",
    reason: "Cargo sparse registry index",
  },
  {
    host: "static.crates.io",
    purpose: "registry",
    reason: "Rust crate downloads",
  },
  {
    host: "pypi.org",
    purpose: "registry",
    reason: "Python package index",
  },
  {
    host: "files.pythonhosted.org",
    purpose: "registry",
    reason: "Python package downloads",
  },
  {
    host: "static.rust-lang.org",
    purpose: "registry",
    reason: "Rust toolchain downloads",
  },
  {
    host: "cdn.playwright.dev",
    purpose: "registry",
    reason: "Playwright browser downloads",
  },
];

/** Hosts for each agent provider, keyed by provider id. */
export const PROVIDER_EGRESS_RULES: Readonly<
  Record<string, readonly EgressHostRule[]>
> = {
  [CLAUDE_PROVIDER_ID]: [
    {
      host: "api.anthropic.com",
      purpose: "agent-provider",
      provider: CLAUDE_PROVIDER_ID,
      reason: "Messages API",
    },
    {
      host: "console.anthropic.com",
      purpose: "agent-provider",
      provider: CLAUDE_PROVIDER_ID,
      reason: "OAuth token refresh",
    },
    {
      host: "platform.claude.com",
      purpose: "agent-provider",
      provider: CLAUDE_PROVIDER_ID,
      reason: "OAuth token refresh (newer CLI)",
    },
  ],
  [CODEX_PROVIDER_ID]: [
    {
      host: "api.openai.com",
      purpose: "agent-provider",
      provider: CODEX_PROVIDER_ID,
      reason: "Responses API",
    },
    {
      host: "auth.openai.com",
      purpose: "agent-provider",
      provider: CODEX_PROVIDER_ID,
      reason: "ChatGPT sign-in token refresh",
    },
    {
      host: "chatgpt.com",
      purpose: "agent-provider",
      provider: CODEX_PROVIDER_ID,
      reason: "Codex backend for ChatGPT plans",
    },
  ],
  [GEMINI_PROVIDER_ID]: [
    {
      host: "generativelanguage.googleapis.com",
      purpose: "agent-provider",
      provider: GEMINI_PROVIDER_ID,
      reason: "Gemini API",
    },
    {
      host: "cloudcode-pa.googleapis.com",
      purpose: "agent-provider",
      provider: GEMINI_PROVIDER_ID,
      reason: "Gemini CLI Google sign-in backend",
    },
    {
      host: "oauth2.googleapis.com",
      purpose: "agent-provider",
      provider: GEMINI_PROVIDER_ID,
      reason: "Google OAuth token refresh",
    },
  ],
  [DEEPSEEK_PROVIDER_ID]: [
    {
      host: DEEPSEEK_HOST,
      purpose: "agent-provider",
      provider: DEEPSEEK_PROVIDER_ID,
      reason: "Anthropic-compatible endpoint",
    },
  ],
};

/** The imgbb host, only when imgbb is configured. */
export const IMGBB_EGRESS_RULES: readonly EgressHostRule[] = [
  {
    host: "api.imgbb.com",
    purpose: "imgbb",
    reason: "evidence screenshot upload",
  },
];

const EGRESS_PORT = "443";
const MAX_HOST_LENGTH = 253;
const LABEL_PATTERN = /^[a-z0-9-]{1,63}$/;
const DIGITS_ONLY = /^\d+$/;
const WHITESPACE_OR_CONTROL = /[\s\p{Cc}]/u;

/**
 * Validate one operator `egress_allow_hosts` entry and normalise it.
 *
 * @param entry - The raw config value
 * @returns The lower-case host, with any `:443` stripped and `*.` kept
 * @throws Error naming the entry when it is not a valid host
 */
export function validateEgressHost(entry: unknown): string {
  const fail = (why: string): never => {
    throw new Error(
      `egress_allow_hosts entry ${
        JSON.stringify(entry)
      } is not a valid host: ${why}`,
    );
  };
  if (typeof entry !== "string") return fail("must be a string");
  if (entry === "") return fail("is empty");
  if (WHITESPACE_OR_CONTROL.test(entry)) {
    return fail("contains whitespace or a control character");
  }

  let host = entry.toLowerCase();
  const colon = host.indexOf(":");
  if (colon !== -1) {
    const port = host.slice(colon + 1);
    if (port !== EGRESS_PORT) {
      return fail(
        DIGITS_ONLY.test(port)
          ? "only port 443 is allowed"
          : "must be a hostname or *.hostname",
      );
    }
    host = host.slice(0, colon);
  }

  const wildcard = host.startsWith("*.");
  const name = wildcard ? host.slice(2) : host;
  if (host === "*" || (wildcard && name === "")) {
    return fail("a bare wildcard is not allowed");
  }
  if (name === "") return fail("is empty");
  if (name.length > MAX_HOST_LENGTH) {
    return fail(`is longer than ${MAX_HOST_LENGTH} characters`);
  }

  const labels = name.split(".");
  if (DIGITS_ONLY.test(labels.at(-1) ?? "")) {
    return fail("IP literals are not allowed");
  }
  if (labels.length < 2) return fail("must have at least two labels");
  for (const label of labels) {
    if (
      !LABEL_PATTERN.test(label) || label.startsWith("-") || label.endsWith("-")
    ) {
      return fail("must be a hostname or *.hostname");
    }
  }
  return wildcard ? `*.${name}` : name;
}

/**
 * The hostname of `ANTHROPIC_BASE_URL`, or undefined when it names nothing
 * external (unset, a single label such as localhost or [::1], or an IPv4
 * literal).
 *
 * @param raw - The environment value
 * @returns The lower-case external hostname, or undefined
 * @throws Error naming `ANTHROPIC_BASE_URL` when the value is not a URL
 */
function anthropicBaseUrlHost(raw: string | undefined): string | undefined {
  const value = (raw ?? "").trim();
  if (value === "") return undefined;

  let hostname: string;
  try {
    hostname = new URL(value).hostname;
  } catch {
    throw new Error("ANTHROPIC_BASE_URL is not a valid URL");
  }
  // Local, not external: a single label (localhost, [::1]) or an IPv4 literal.
  const labels = hostname.split(".");
  if (labels.length < 2 || DIGITS_ONLY.test(labels.at(-1) ?? "")) {
    return undefined;
  }
  return hostname.toLowerCase();
}

/**
 * Resolve the full, de-duplicated egress allowlist for this worker.
 *
 * @param input - Enabled provider ids, imgbb state, base URL and operator extras
 * @returns Hosts in order, first occurrence wins
 * @throws Error when `ANTHROPIC_BASE_URL` is not a URL, or an extra is invalid
 */
export function resolveEgressAllowlist(input: {
  enabledProviderIds: readonly string[];
  imgbbConfigured: boolean;
  anthropicBaseUrl?: string;
  extraHosts?: unknown;
}): string[] {
  const hosts: string[] = [];
  const seen = new Set<string>();
  const add = (host: string): void => {
    if (seen.has(host)) return;
    seen.add(host);
    hosts.push(host);
  };
  const builtinFor = (purpose: EgressPurpose): void => {
    for (const rule of BUILTIN_EGRESS_RULES) {
      if (rule.purpose === purpose) add(rule.host);
    }
  };

  builtinFor("github");
  for (const id of input.enabledProviderIds) {
    if (!Object.hasOwn(PROVIDER_EGRESS_RULES, id)) continue;
    for (const rule of PROVIDER_EGRESS_RULES[id] ?? []) add(rule.host);
  }
  if (input.imgbbConfigured) {
    for (const rule of IMGBB_EGRESS_RULES) add(rule.host);
  }
  builtinFor("registry");

  const baseHost = anthropicBaseUrlHost(input.anthropicBaseUrl);
  if (baseHost !== undefined) add(baseHost);

  if (input.extraHosts !== undefined) {
    if (!Array.isArray(input.extraHosts)) {
      throw new Error("egress_allow_hosts must be an array of hostnames");
    }
    for (const entry of input.extraHosts) add(validateEgressHost(entry));
  }

  return hosts;
}
