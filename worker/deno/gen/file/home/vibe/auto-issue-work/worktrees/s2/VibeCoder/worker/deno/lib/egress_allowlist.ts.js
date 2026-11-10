/**
 * Egress allowlist (Issue #4045): the single list of hosts the container may
 * reach. GitHub and the package registries are always on; agent-provider
 * hosts follow the enabled providers; the imgbb host follows imgbb being
 * configured; the ANTHROPIC_BASE_URL host and operator `egress_allow_hosts`
 * extras are appended last.
 *
 * The CONNECT egress proxy (#4046, `egress-proxy`) takes its allowlist from
 * `--allow` or `VIBE_EGRESS_ALLOW_HOSTS`. The launch plan (Issue #4047) feeds
 * this resolved list into that variable and routes the Docker and Podman
 * worker through the proxy. `loadConfig` still validates `egress_allow_hosts`
 * at startup. Apple container is not routed through the proxy yet
 * (Issue #4051).
 *
 * Australian English spelling throughout (normalised, behaviour).
 */ import { CLAUDE_PROVIDER_ID, CODEX_PROVIDER_ID, DEEPSEEK_PROVIDER_ID, GEMINI_PROVIDER_ID } from "./agent_provider.ts";
import { DEEPSEEK_ANTHROPIC_BASE_URL } from "./deepseek_env.ts";
const DEEPSEEK_HOST = new URL(DEEPSEEK_ANTHROPIC_BASE_URL).hostname;
/** GitHub (the control plane) and the package registries, always on. */ export const BUILTIN_EGRESS_RULES = [
  // GitHub
  {
    host: "github.com",
    purpose: "github",
    reason: "git transport and web"
  },
  {
    host: "api.github.com",
    purpose: "github",
    reason: "REST and GraphQL API"
  },
  {
    host: "uploads.github.com",
    purpose: "github",
    reason: "release asset uploads"
  },
  {
    host: "codeload.github.com",
    purpose: "github",
    reason: "archive tarball downloads"
  },
  {
    host: "objects.githubusercontent.com",
    purpose: "github",
    reason: "release asset and attachment downloads"
  },
  {
    host: "raw.githubusercontent.com",
    purpose: "github",
    reason: "raw file downloads"
  },
  // `gh api …/actions/jobs/<id>/logs` answers with a redirect into these
  // storage accounts, so without them the CI-failure fixer gets no log
  // excerpt (Issue #4412). GitHub added 30–49 and 100–199 on 22 October
  // 2026; keep exact hosts rather than allowing other Azure accounts.
  // https://github.blog/changelog/2026-10-22-meta-api-endpoints-updated-for-actions-blob-storage/
  ...[
    [
      0,
      19
    ],
    [
      30,
      49
    ],
    [
      100,
      199
    ]
  ].flatMap(([first, last])=>Array.from({
      length: last - first + 1
    }, (_, offset)=>({
        host: `productionresultssa${first + offset}.blob.core.windows.net`,
        purpose: "github",
        reason: "Actions job logs and artefacts"
      }))),
  // Package registries
  {
    host: "registry.npmjs.org",
    purpose: "registry",
    reason: "npm packages"
  },
  {
    host: "jsr.io",
    purpose: "registry",
    reason: "JSR packages"
  },
  {
    host: "deno.land",
    purpose: "registry",
    reason: "Deno standard library and third-party modules"
  },
  {
    // `deno upgrade <version>` and `deno compile` (its `denort` runtime)
    // download Deno release binaries from here (Issue #4566).
    host: "dl.deno.land",
    purpose: "registry",
    reason: "Deno release downloads"
  },
  {
    // Deno projects import npm packages as ES modules from here; refused,
    // their `deno task check` fails on every merge (GRQ-AutoTrader `web/`).
    host: "esm.sh",
    purpose: "registry",
    reason: "npm packages as ES modules for Deno"
  },
  {
    host: "crates.io",
    purpose: "registry",
    reason: "Rust crate index API"
  },
  {
    host: "index.crates.io",
    purpose: "registry",
    reason: "Cargo sparse registry index"
  },
  {
    host: "static.crates.io",
    purpose: "registry",
    reason: "Rust crate downloads"
  },
  {
    host: "pypi.org",
    purpose: "registry",
    reason: "Python package index"
  },
  {
    host: "files.pythonhosted.org",
    purpose: "registry",
    reason: "Python package downloads"
  },
  {
    host: "static.rust-lang.org",
    purpose: "registry",
    reason: "Rust toolchain downloads"
  },
  {
    host: "cdn.playwright.dev",
    purpose: "registry",
    reason: "Playwright browser downloads"
  },
  {
    // The quality gate's SAST stage fetches its `p/default` rules from here
    // on every scan; refused, every gate fails on every repo (Issue #4412).
    host: "semgrep.dev",
    purpose: "registry",
    reason: "Semgrep rule registry for the quality gate"
  }
];
/** Hosts for each agent provider, keyed by provider id. */ export const PROVIDER_EGRESS_RULES = {
  [CLAUDE_PROVIDER_ID]: [
    {
      host: "api.anthropic.com",
      purpose: "agent-provider",
      provider: CLAUDE_PROVIDER_ID,
      reason: "Messages API"
    },
    {
      host: "console.anthropic.com",
      purpose: "agent-provider",
      provider: CLAUDE_PROVIDER_ID,
      reason: "OAuth token refresh"
    },
    {
      host: "platform.claude.com",
      purpose: "agent-provider",
      provider: CLAUDE_PROVIDER_ID,
      reason: "OAuth token refresh (newer CLI)"
    }
  ],
  [CODEX_PROVIDER_ID]: [
    {
      host: "api.openai.com",
      purpose: "agent-provider",
      provider: CODEX_PROVIDER_ID,
      reason: "Responses API"
    },
    {
      host: "auth.openai.com",
      purpose: "agent-provider",
      provider: CODEX_PROVIDER_ID,
      reason: "ChatGPT sign-in token refresh"
    },
    {
      host: "chatgpt.com",
      purpose: "agent-provider",
      provider: CODEX_PROVIDER_ID,
      reason: "Codex backend for ChatGPT plans"
    },
    {
      host: "ab.chatgpt.com",
      purpose: "agent-provider",
      provider: CODEX_PROVIDER_ID,
      reason: "Codex CLI experiment and feature flags"
    },
    {
      host: "*.oaiusercontent.com",
      purpose: "agent-provider",
      provider: CODEX_PROVIDER_ID,
      reason: "ChatGPT file storage the Codex backend hands out signed URLs for"
    }
  ],
  [GEMINI_PROVIDER_ID]: [
    {
      host: "generativelanguage.googleapis.com",
      purpose: "agent-provider",
      provider: GEMINI_PROVIDER_ID,
      reason: "Gemini API"
    },
    {
      host: "cloudcode-pa.googleapis.com",
      purpose: "agent-provider",
      provider: GEMINI_PROVIDER_ID,
      reason: "Gemini CLI Google sign-in backend"
    },
    {
      host: "oauth2.googleapis.com",
      purpose: "agent-provider",
      provider: GEMINI_PROVIDER_ID,
      reason: "Google OAuth token refresh"
    }
  ],
  [DEEPSEEK_PROVIDER_ID]: [
    {
      host: DEEPSEEK_HOST,
      purpose: "agent-provider",
      provider: DEEPSEEK_PROVIDER_ID,
      reason: "Anthropic-compatible endpoint"
    }
  ]
};
/** The imgbb host, only when imgbb is configured. */ export const IMGBB_EGRESS_RULES = [
  {
    host: "api.imgbb.com",
    purpose: "imgbb",
    reason: "evidence screenshot upload"
  }
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
 */ export function validateEgressHost(entry) {
  const fail = (why)=>{
    throw new Error(`egress_allow_hosts entry ${JSON.stringify(entry)} is not a valid host: ${why}`);
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
      return fail(DIGITS_ONLY.test(port) ? "only port 443 is allowed" : "must be a hostname or *.hostname");
    }
    host = host.slice(0, colon);
  }
  const wildcard = host.startsWith("*.");
  const name = wildcard ? host.slice(2) : host;
  if (host === "*" || wildcard && name === "") {
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
  for (const label of labels){
    if (!LABEL_PATTERN.test(label) || label.startsWith("-") || label.endsWith("-")) {
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
 */ function anthropicBaseUrlHost(raw) {
  const value = (raw ?? "").trim();
  if (value === "") return undefined;
  let hostname;
  try {
    hostname = new URL(value).hostname;
  } catch  {
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
 */ export function resolveEgressAllowlist(input) {
  const hosts = [];
  const seen = new Set();
  const add = (host)=>{
    if (seen.has(host)) return;
    seen.add(host);
    hosts.push(host);
  };
  const builtinFor = (purpose)=>{
    for (const rule of BUILTIN_EGRESS_RULES){
      if (rule.purpose === purpose) add(rule.host);
    }
  };
  builtinFor("github");
  for (const id of input.enabledProviderIds){
    if (!Object.hasOwn(PROVIDER_EGRESS_RULES, id)) continue;
    for (const rule of PROVIDER_EGRESS_RULES[id] ?? [])add(rule.host);
  }
  if (input.imgbbConfigured) {
    for (const rule of IMGBB_EGRESS_RULES)add(rule.host);
  }
  builtinFor("registry");
  const baseHost = anthropicBaseUrlHost(input.anthropicBaseUrl);
  if (baseHost !== undefined) add(baseHost);
  if (input.extraHosts !== undefined) {
    if (!Array.isArray(input.extraHosts)) {
      throw new Error("egress_allow_hosts must be an array of hostnames");
    }
    for (const entry of input.extraHosts)add(validateEgressHost(entry));
  }
  return hosts;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9lZ3Jlc3NfYWxsb3dsaXN0LnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogRWdyZXNzIGFsbG93bGlzdCAoSXNzdWUgIzQwNDUpOiB0aGUgc2luZ2xlIGxpc3Qgb2YgaG9zdHMgdGhlIGNvbnRhaW5lciBtYXlcbiAqIHJlYWNoLiBHaXRIdWIgYW5kIHRoZSBwYWNrYWdlIHJlZ2lzdHJpZXMgYXJlIGFsd2F5cyBvbjsgYWdlbnQtcHJvdmlkZXJcbiAqIGhvc3RzIGZvbGxvdyB0aGUgZW5hYmxlZCBwcm92aWRlcnM7IHRoZSBpbWdiYiBob3N0IGZvbGxvd3MgaW1nYmIgYmVpbmdcbiAqIGNvbmZpZ3VyZWQ7IHRoZSBBTlRIUk9QSUNfQkFTRV9VUkwgaG9zdCBhbmQgb3BlcmF0b3IgYGVncmVzc19hbGxvd19ob3N0c2BcbiAqIGV4dHJhcyBhcmUgYXBwZW5kZWQgbGFzdC5cbiAqXG4gKiBUaGUgQ09OTkVDVCBlZ3Jlc3MgcHJveHkgKCM0MDQ2LCBgZWdyZXNzLXByb3h5YCkgdGFrZXMgaXRzIGFsbG93bGlzdCBmcm9tXG4gKiBgLS1hbGxvd2Agb3IgYFZJQkVfRUdSRVNTX0FMTE9XX0hPU1RTYC4gVGhlIGxhdW5jaCBwbGFuIChJc3N1ZSAjNDA0NykgZmVlZHNcbiAqIHRoaXMgcmVzb2x2ZWQgbGlzdCBpbnRvIHRoYXQgdmFyaWFibGUgYW5kIHJvdXRlcyB0aGUgRG9ja2VyIGFuZCBQb2RtYW5cbiAqIHdvcmtlciB0aHJvdWdoIHRoZSBwcm94eS4gYGxvYWRDb25maWdgIHN0aWxsIHZhbGlkYXRlcyBgZWdyZXNzX2FsbG93X2hvc3RzYFxuICogYXQgc3RhcnR1cC4gQXBwbGUgY29udGFpbmVyIGlzIG5vdCByb3V0ZWQgdGhyb3VnaCB0aGUgcHJveHkgeWV0XG4gKiAoSXNzdWUgIzQwNTEpLlxuICpcbiAqIEF1c3RyYWxpYW4gRW5nbGlzaCBzcGVsbGluZyB0aHJvdWdob3V0IChub3JtYWxpc2VkLCBiZWhhdmlvdXIpLlxuICovXG5cbmltcG9ydCB7XG4gIENMQVVERV9QUk9WSURFUl9JRCxcbiAgQ09ERVhfUFJPVklERVJfSUQsXG4gIERFRVBTRUVLX1BST1ZJREVSX0lELFxuICBHRU1JTklfUFJPVklERVJfSUQsXG59IGZyb20gXCIuL2FnZW50X3Byb3ZpZGVyLnRzXCI7XG5pbXBvcnQgeyBERUVQU0VFS19BTlRIUk9QSUNfQkFTRV9VUkwgfSBmcm9tIFwiLi9kZWVwc2Vla19lbnYudHNcIjtcblxuLyoqIFdoeSBhIGhvc3QgaXMgb24gdGhlIGxpc3QuICovXG5leHBvcnQgdHlwZSBFZ3Jlc3NQdXJwb3NlID0gXCJnaXRodWJcIiB8IFwiYWdlbnQtcHJvdmlkZXJcIiB8IFwiaW1nYmJcIiB8IFwicmVnaXN0cnlcIjtcblxuLyoqIE9uZSBob3N0IHRoZSBjb250YWluZXIgbWF5IHJlYWNoLCB3aXRoIGl0cyBwdXJwb3NlLiAqL1xuZXhwb3J0IGludGVyZmFjZSBFZ3Jlc3NIb3N0UnVsZSB7XG4gIHJlYWRvbmx5IGhvc3Q6IHN0cmluZztcbiAgcmVhZG9ubHkgcHVycG9zZTogRWdyZXNzUHVycG9zZTtcbiAgcmVhZG9ubHkgcmVhc29uOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHByb3ZpZGVyPzogc3RyaW5nO1xufVxuXG5jb25zdCBERUVQU0VFS19IT1NUID0gbmV3IFVSTChERUVQU0VFS19BTlRIUk9QSUNfQkFTRV9VUkwpLmhvc3RuYW1lO1xuXG4vKiogR2l0SHViICh0aGUgY29udHJvbCBwbGFuZSkgYW5kIHRoZSBwYWNrYWdlIHJlZ2lzdHJpZXMsIGFsd2F5cyBvbi4gKi9cbmV4cG9ydCBjb25zdCBCVUlMVElOX0VHUkVTU19SVUxFUzogcmVhZG9ubHkgRWdyZXNzSG9zdFJ1bGVbXSA9IFtcbiAgLy8gR2l0SHViXG4gIHtcbiAgICBob3N0OiBcImdpdGh1Yi5jb21cIixcbiAgICBwdXJwb3NlOiBcImdpdGh1YlwiLFxuICAgIHJlYXNvbjogXCJnaXQgdHJhbnNwb3J0IGFuZCB3ZWJcIixcbiAgfSxcbiAge1xuICAgIGhvc3Q6IFwiYXBpLmdpdGh1Yi5jb21cIixcbiAgICBwdXJwb3NlOiBcImdpdGh1YlwiLFxuICAgIHJlYXNvbjogXCJSRVNUIGFuZCBHcmFwaFFMIEFQSVwiLFxuICB9LFxuICB7XG4gICAgaG9zdDogXCJ1cGxvYWRzLmdpdGh1Yi5jb21cIixcbiAgICBwdXJwb3NlOiBcImdpdGh1YlwiLFxuICAgIHJlYXNvbjogXCJyZWxlYXNlIGFzc2V0IHVwbG9hZHNcIixcbiAgfSxcbiAge1xuICAgIGhvc3Q6IFwiY29kZWxvYWQuZ2l0aHViLmNvbVwiLFxuICAgIHB1cnBvc2U6IFwiZ2l0aHViXCIsXG4gICAgcmVhc29uOiBcImFyY2hpdmUgdGFyYmFsbCBkb3dubG9hZHNcIixcbiAgfSxcbiAge1xuICAgIGhvc3Q6IFwib2JqZWN0cy5naXRodWJ1c2VyY29udGVudC5jb21cIixcbiAgICBwdXJwb3NlOiBcImdpdGh1YlwiLFxuICAgIHJlYXNvbjogXCJyZWxlYXNlIGFzc2V0IGFuZCBhdHRhY2htZW50IGRvd25sb2Fkc1wiLFxuICB9LFxuICB7XG4gICAgaG9zdDogXCJyYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tXCIsXG4gICAgcHVycG9zZTogXCJnaXRodWJcIixcbiAgICByZWFzb246IFwicmF3IGZpbGUgZG93bmxvYWRzXCIsXG4gIH0sXG4gIC8vIGBnaCBhcGkg4oCmL2FjdGlvbnMvam9icy88aWQ+L2xvZ3NgIGFuc3dlcnMgd2l0aCBhIHJlZGlyZWN0IGludG8gdGhlc2VcbiAgLy8gc3RvcmFnZSBhY2NvdW50cywgc28gd2l0aG91dCB0aGVtIHRoZSBDSS1mYWlsdXJlIGZpeGVyIGdldHMgbm8gbG9nXG4gIC8vIGV4Y2VycHQgKElzc3VlICM0NDEyKS4gR2l0SHViIGFkZGVkIDMw4oCTNDkgYW5kIDEwMOKAkzE5OSBvbiAyMiBPY3RvYmVyXG4gIC8vIDIwMjY7IGtlZXAgZXhhY3QgaG9zdHMgcmF0aGVyIHRoYW4gYWxsb3dpbmcgb3RoZXIgQXp1cmUgYWNjb3VudHMuXG4gIC8vIGh0dHBzOi8vZ2l0aHViLmJsb2cvY2hhbmdlbG9nLzIwMjYtMTAtMjItbWV0YS1hcGktZW5kcG9pbnRzLXVwZGF0ZWQtZm9yLWFjdGlvbnMtYmxvYi1zdG9yYWdlL1xuICAuLi4oW1swLCAxOV0sIFszMCwgNDldLCBbMTAwLCAxOTldXSBhcyBjb25zdCkuZmxhdE1hcCgoW2ZpcnN0LCBsYXN0XSkgPT5cbiAgICBBcnJheS5mcm9tKHsgbGVuZ3RoOiBsYXN0IC0gZmlyc3QgKyAxIH0sIChfLCBvZmZzZXQpOiBFZ3Jlc3NIb3N0UnVsZSA9PiAoe1xuICAgICAgaG9zdDogYHByb2R1Y3Rpb25yZXN1bHRzc2Eke2ZpcnN0ICsgb2Zmc2V0fS5ibG9iLmNvcmUud2luZG93cy5uZXRgLFxuICAgICAgcHVycG9zZTogXCJnaXRodWJcIixcbiAgICAgIHJlYXNvbjogXCJBY3Rpb25zIGpvYiBsb2dzIGFuZCBhcnRlZmFjdHNcIixcbiAgICB9KSlcbiAgKSxcbiAgLy8gUGFja2FnZSByZWdpc3RyaWVzXG4gIHtcbiAgICBob3N0OiBcInJlZ2lzdHJ5Lm5wbWpzLm9yZ1wiLFxuICAgIHB1cnBvc2U6IFwicmVnaXN0cnlcIixcbiAgICByZWFzb246IFwibnBtIHBhY2thZ2VzXCIsXG4gIH0sXG4gIHtcbiAgICBob3N0OiBcImpzci5pb1wiLFxuICAgIHB1cnBvc2U6IFwicmVnaXN0cnlcIixcbiAgICByZWFzb246IFwiSlNSIHBhY2thZ2VzXCIsXG4gIH0sXG4gIHtcbiAgICBob3N0OiBcImRlbm8ubGFuZFwiLFxuICAgIHB1cnBvc2U6IFwicmVnaXN0cnlcIixcbiAgICByZWFzb246IFwiRGVubyBzdGFuZGFyZCBsaWJyYXJ5IGFuZCB0aGlyZC1wYXJ0eSBtb2R1bGVzXCIsXG4gIH0sXG4gIHtcbiAgICAvLyBgZGVubyB1cGdyYWRlIDx2ZXJzaW9uPmAgYW5kIGBkZW5vIGNvbXBpbGVgIChpdHMgYGRlbm9ydGAgcnVudGltZSlcbiAgICAvLyBkb3dubG9hZCBEZW5vIHJlbGVhc2UgYmluYXJpZXMgZnJvbSBoZXJlIChJc3N1ZSAjNDU2NikuXG4gICAgaG9zdDogXCJkbC5kZW5vLmxhbmRcIixcbiAgICBwdXJwb3NlOiBcInJlZ2lzdHJ5XCIsXG4gICAgcmVhc29uOiBcIkRlbm8gcmVsZWFzZSBkb3dubG9hZHNcIixcbiAgfSxcbiAge1xuICAgIC8vIERlbm8gcHJvamVjdHMgaW1wb3J0IG5wbSBwYWNrYWdlcyBhcyBFUyBtb2R1bGVzIGZyb20gaGVyZTsgcmVmdXNlZCxcbiAgICAvLyB0aGVpciBgZGVubyB0YXNrIGNoZWNrYCBmYWlscyBvbiBldmVyeSBtZXJnZSAoR1JRLUF1dG9UcmFkZXIgYHdlYi9gKS5cbiAgICBob3N0OiBcImVzbS5zaFwiLFxuICAgIHB1cnBvc2U6IFwicmVnaXN0cnlcIixcbiAgICByZWFzb246IFwibnBtIHBhY2thZ2VzIGFzIEVTIG1vZHVsZXMgZm9yIERlbm9cIixcbiAgfSxcbiAge1xuICAgIGhvc3Q6IFwiY3JhdGVzLmlvXCIsXG4gICAgcHVycG9zZTogXCJyZWdpc3RyeVwiLFxuICAgIHJlYXNvbjogXCJSdXN0IGNyYXRlIGluZGV4IEFQSVwiLFxuICB9LFxuICB7XG4gICAgaG9zdDogXCJpbmRleC5jcmF0ZXMuaW9cIixcbiAgICBwdXJwb3NlOiBcInJlZ2lzdHJ5XCIsXG4gICAgcmVhc29uOiBcIkNhcmdvIHNwYXJzZSByZWdpc3RyeSBpbmRleFwiLFxuICB9LFxuICB7XG4gICAgaG9zdDogXCJzdGF0aWMuY3JhdGVzLmlvXCIsXG4gICAgcHVycG9zZTogXCJyZWdpc3RyeVwiLFxuICAgIHJlYXNvbjogXCJSdXN0IGNyYXRlIGRvd25sb2Fkc1wiLFxuICB9LFxuICB7XG4gICAgaG9zdDogXCJweXBpLm9yZ1wiLFxuICAgIHB1cnBvc2U6IFwicmVnaXN0cnlcIixcbiAgICByZWFzb246IFwiUHl0aG9uIHBhY2thZ2UgaW5kZXhcIixcbiAgfSxcbiAge1xuICAgIGhvc3Q6IFwiZmlsZXMucHl0aG9uaG9zdGVkLm9yZ1wiLFxuICAgIHB1cnBvc2U6IFwicmVnaXN0cnlcIixcbiAgICByZWFzb246IFwiUHl0aG9uIHBhY2thZ2UgZG93bmxvYWRzXCIsXG4gIH0sXG4gIHtcbiAgICBob3N0OiBcInN0YXRpYy5ydXN0LWxhbmcub3JnXCIsXG4gICAgcHVycG9zZTogXCJyZWdpc3RyeVwiLFxuICAgIHJlYXNvbjogXCJSdXN0IHRvb2xjaGFpbiBkb3dubG9hZHNcIixcbiAgfSxcbiAge1xuICAgIGhvc3Q6IFwiY2RuLnBsYXl3cmlnaHQuZGV2XCIsXG4gICAgcHVycG9zZTogXCJyZWdpc3RyeVwiLFxuICAgIHJlYXNvbjogXCJQbGF5d3JpZ2h0IGJyb3dzZXIgZG93bmxvYWRzXCIsXG4gIH0sXG4gIHtcbiAgICAvLyBUaGUgcXVhbGl0eSBnYXRlJ3MgU0FTVCBzdGFnZSBmZXRjaGVzIGl0cyBgcC9kZWZhdWx0YCBydWxlcyBmcm9tIGhlcmVcbiAgICAvLyBvbiBldmVyeSBzY2FuOyByZWZ1c2VkLCBldmVyeSBnYXRlIGZhaWxzIG9uIGV2ZXJ5IHJlcG8gKElzc3VlICM0NDEyKS5cbiAgICBob3N0OiBcInNlbWdyZXAuZGV2XCIsXG4gICAgcHVycG9zZTogXCJyZWdpc3RyeVwiLFxuICAgIHJlYXNvbjogXCJTZW1ncmVwIHJ1bGUgcmVnaXN0cnkgZm9yIHRoZSBxdWFsaXR5IGdhdGVcIixcbiAgfSxcbl07XG5cbi8qKiBIb3N0cyBmb3IgZWFjaCBhZ2VudCBwcm92aWRlciwga2V5ZWQgYnkgcHJvdmlkZXIgaWQuICovXG5leHBvcnQgY29uc3QgUFJPVklERVJfRUdSRVNTX1JVTEVTOiBSZWFkb25seTxcbiAgUmVjb3JkPHN0cmluZywgcmVhZG9ubHkgRWdyZXNzSG9zdFJ1bGVbXT5cbj4gPSB7XG4gIFtDTEFVREVfUFJPVklERVJfSURdOiBbXG4gICAge1xuICAgICAgaG9zdDogXCJhcGkuYW50aHJvcGljLmNvbVwiLFxuICAgICAgcHVycG9zZTogXCJhZ2VudC1wcm92aWRlclwiLFxuICAgICAgcHJvdmlkZXI6IENMQVVERV9QUk9WSURFUl9JRCxcbiAgICAgIHJlYXNvbjogXCJNZXNzYWdlcyBBUElcIixcbiAgICB9LFxuICAgIHtcbiAgICAgIGhvc3Q6IFwiY29uc29sZS5hbnRocm9waWMuY29tXCIsXG4gICAgICBwdXJwb3NlOiBcImFnZW50LXByb3ZpZGVyXCIsXG4gICAgICBwcm92aWRlcjogQ0xBVURFX1BST1ZJREVSX0lELFxuICAgICAgcmVhc29uOiBcIk9BdXRoIHRva2VuIHJlZnJlc2hcIixcbiAgICB9LFxuICAgIHtcbiAgICAgIGhvc3Q6IFwicGxhdGZvcm0uY2xhdWRlLmNvbVwiLFxuICAgICAgcHVycG9zZTogXCJhZ2VudC1wcm92aWRlclwiLFxuICAgICAgcHJvdmlkZXI6IENMQVVERV9QUk9WSURFUl9JRCxcbiAgICAgIHJlYXNvbjogXCJPQXV0aCB0b2tlbiByZWZyZXNoIChuZXdlciBDTEkpXCIsXG4gICAgfSxcbiAgXSxcbiAgW0NPREVYX1BST1ZJREVSX0lEXTogW1xuICAgIHtcbiAgICAgIGhvc3Q6IFwiYXBpLm9wZW5haS5jb21cIixcbiAgICAgIHB1cnBvc2U6IFwiYWdlbnQtcHJvdmlkZXJcIixcbiAgICAgIHByb3ZpZGVyOiBDT0RFWF9QUk9WSURFUl9JRCxcbiAgICAgIHJlYXNvbjogXCJSZXNwb25zZXMgQVBJXCIsXG4gICAgfSxcbiAgICB7XG4gICAgICBob3N0OiBcImF1dGgub3BlbmFpLmNvbVwiLFxuICAgICAgcHVycG9zZTogXCJhZ2VudC1wcm92aWRlclwiLFxuICAgICAgcHJvdmlkZXI6IENPREVYX1BST1ZJREVSX0lELFxuICAgICAgcmVhc29uOiBcIkNoYXRHUFQgc2lnbi1pbiB0b2tlbiByZWZyZXNoXCIsXG4gICAgfSxcbiAgICB7XG4gICAgICBob3N0OiBcImNoYXRncHQuY29tXCIsXG4gICAgICBwdXJwb3NlOiBcImFnZW50LXByb3ZpZGVyXCIsXG4gICAgICBwcm92aWRlcjogQ09ERVhfUFJPVklERVJfSUQsXG4gICAgICByZWFzb246IFwiQ29kZXggYmFja2VuZCBmb3IgQ2hhdEdQVCBwbGFuc1wiLFxuICAgIH0sXG4gICAge1xuICAgICAgaG9zdDogXCJhYi5jaGF0Z3B0LmNvbVwiLFxuICAgICAgcHVycG9zZTogXCJhZ2VudC1wcm92aWRlclwiLFxuICAgICAgcHJvdmlkZXI6IENPREVYX1BST1ZJREVSX0lELFxuICAgICAgcmVhc29uOiBcIkNvZGV4IENMSSBleHBlcmltZW50IGFuZCBmZWF0dXJlIGZsYWdzXCIsXG4gICAgfSxcbiAgICB7XG4gICAgICBob3N0OiBcIioub2FpdXNlcmNvbnRlbnQuY29tXCIsXG4gICAgICBwdXJwb3NlOiBcImFnZW50LXByb3ZpZGVyXCIsXG4gICAgICBwcm92aWRlcjogQ09ERVhfUFJPVklERVJfSUQsXG4gICAgICByZWFzb246XG4gICAgICAgIFwiQ2hhdEdQVCBmaWxlIHN0b3JhZ2UgdGhlIENvZGV4IGJhY2tlbmQgaGFuZHMgb3V0IHNpZ25lZCBVUkxzIGZvclwiLFxuICAgIH0sXG4gIF0sXG4gIFtHRU1JTklfUFJPVklERVJfSURdOiBbXG4gICAge1xuICAgICAgaG9zdDogXCJnZW5lcmF0aXZlbGFuZ3VhZ2UuZ29vZ2xlYXBpcy5jb21cIixcbiAgICAgIHB1cnBvc2U6IFwiYWdlbnQtcHJvdmlkZXJcIixcbiAgICAgIHByb3ZpZGVyOiBHRU1JTklfUFJPVklERVJfSUQsXG4gICAgICByZWFzb246IFwiR2VtaW5pIEFQSVwiLFxuICAgIH0sXG4gICAge1xuICAgICAgaG9zdDogXCJjbG91ZGNvZGUtcGEuZ29vZ2xlYXBpcy5jb21cIixcbiAgICAgIHB1cnBvc2U6IFwiYWdlbnQtcHJvdmlkZXJcIixcbiAgICAgIHByb3ZpZGVyOiBHRU1JTklfUFJPVklERVJfSUQsXG4gICAgICByZWFzb246IFwiR2VtaW5pIENMSSBHb29nbGUgc2lnbi1pbiBiYWNrZW5kXCIsXG4gICAgfSxcbiAgICB7XG4gICAgICBob3N0OiBcIm9hdXRoMi5nb29nbGVhcGlzLmNvbVwiLFxuICAgICAgcHVycG9zZTogXCJhZ2VudC1wcm92aWRlclwiLFxuICAgICAgcHJvdmlkZXI6IEdFTUlOSV9QUk9WSURFUl9JRCxcbiAgICAgIHJlYXNvbjogXCJHb29nbGUgT0F1dGggdG9rZW4gcmVmcmVzaFwiLFxuICAgIH0sXG4gIF0sXG4gIFtERUVQU0VFS19QUk9WSURFUl9JRF06IFtcbiAgICB7XG4gICAgICBob3N0OiBERUVQU0VFS19IT1NULFxuICAgICAgcHVycG9zZTogXCJhZ2VudC1wcm92aWRlclwiLFxuICAgICAgcHJvdmlkZXI6IERFRVBTRUVLX1BST1ZJREVSX0lELFxuICAgICAgcmVhc29uOiBcIkFudGhyb3BpYy1jb21wYXRpYmxlIGVuZHBvaW50XCIsXG4gICAgfSxcbiAgXSxcbn07XG5cbi8qKiBUaGUgaW1nYmIgaG9zdCwgb25seSB3aGVuIGltZ2JiIGlzIGNvbmZpZ3VyZWQuICovXG5leHBvcnQgY29uc3QgSU1HQkJfRUdSRVNTX1JVTEVTOiByZWFkb25seSBFZ3Jlc3NIb3N0UnVsZVtdID0gW1xuICB7XG4gICAgaG9zdDogXCJhcGkuaW1nYmIuY29tXCIsXG4gICAgcHVycG9zZTogXCJpbWdiYlwiLFxuICAgIHJlYXNvbjogXCJldmlkZW5jZSBzY3JlZW5zaG90IHVwbG9hZFwiLFxuICB9LFxuXTtcblxuY29uc3QgRUdSRVNTX1BPUlQgPSBcIjQ0M1wiO1xuY29uc3QgTUFYX0hPU1RfTEVOR1RIID0gMjUzO1xuY29uc3QgTEFCRUxfUEFUVEVSTiA9IC9eW2EtejAtOS1dezEsNjN9JC87XG5jb25zdCBESUdJVFNfT05MWSA9IC9eXFxkKyQvO1xuY29uc3QgV0hJVEVTUEFDRV9PUl9DT05UUk9MID0gL1tcXHNcXHB7Q2N9XS91O1xuXG4vKipcbiAqIFZhbGlkYXRlIG9uZSBvcGVyYXRvciBgZWdyZXNzX2FsbG93X2hvc3RzYCBlbnRyeSBhbmQgbm9ybWFsaXNlIGl0LlxuICpcbiAqIEBwYXJhbSBlbnRyeSAtIFRoZSByYXcgY29uZmlnIHZhbHVlXG4gKiBAcmV0dXJucyBUaGUgbG93ZXItY2FzZSBob3N0LCB3aXRoIGFueSBgOjQ0M2Agc3RyaXBwZWQgYW5kIGAqLmAga2VwdFxuICogQHRocm93cyBFcnJvciBuYW1pbmcgdGhlIGVudHJ5IHdoZW4gaXQgaXMgbm90IGEgdmFsaWQgaG9zdFxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVFZ3Jlc3NIb3N0KGVudHJ5OiB1bmtub3duKTogc3RyaW5nIHtcbiAgY29uc3QgZmFpbCA9ICh3aHk6IHN0cmluZyk6IG5ldmVyID0+IHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgZWdyZXNzX2FsbG93X2hvc3RzIGVudHJ5ICR7XG4gICAgICAgIEpTT04uc3RyaW5naWZ5KGVudHJ5KVxuICAgICAgfSBpcyBub3QgYSB2YWxpZCBob3N0OiAke3doeX1gLFxuICAgICk7XG4gIH07XG4gIGlmICh0eXBlb2YgZW50cnkgIT09IFwic3RyaW5nXCIpIHJldHVybiBmYWlsKFwibXVzdCBiZSBhIHN0cmluZ1wiKTtcbiAgaWYgKGVudHJ5ID09PSBcIlwiKSByZXR1cm4gZmFpbChcImlzIGVtcHR5XCIpO1xuICBpZiAoV0hJVEVTUEFDRV9PUl9DT05UUk9MLnRlc3QoZW50cnkpKSB7XG4gICAgcmV0dXJuIGZhaWwoXCJjb250YWlucyB3aGl0ZXNwYWNlIG9yIGEgY29udHJvbCBjaGFyYWN0ZXJcIik7XG4gIH1cblxuICBsZXQgaG9zdCA9IGVudHJ5LnRvTG93ZXJDYXNlKCk7XG4gIGNvbnN0IGNvbG9uID0gaG9zdC5pbmRleE9mKFwiOlwiKTtcbiAgaWYgKGNvbG9uICE9PSAtMSkge1xuICAgIGNvbnN0IHBvcnQgPSBob3N0LnNsaWNlKGNvbG9uICsgMSk7XG4gICAgaWYgKHBvcnQgIT09IEVHUkVTU19QT1JUKSB7XG4gICAgICByZXR1cm4gZmFpbChcbiAgICAgICAgRElHSVRTX09OTFkudGVzdChwb3J0KVxuICAgICAgICAgID8gXCJvbmx5IHBvcnQgNDQzIGlzIGFsbG93ZWRcIlxuICAgICAgICAgIDogXCJtdXN0IGJlIGEgaG9zdG5hbWUgb3IgKi5ob3N0bmFtZVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgaG9zdCA9IGhvc3Quc2xpY2UoMCwgY29sb24pO1xuICB9XG5cbiAgY29uc3Qgd2lsZGNhcmQgPSBob3N0LnN0YXJ0c1dpdGgoXCIqLlwiKTtcbiAgY29uc3QgbmFtZSA9IHdpbGRjYXJkID8gaG9zdC5zbGljZSgyKSA6IGhvc3Q7XG4gIGlmIChob3N0ID09PSBcIipcIiB8fCAod2lsZGNhcmQgJiYgbmFtZSA9PT0gXCJcIikpIHtcbiAgICByZXR1cm4gZmFpbChcImEgYmFyZSB3aWxkY2FyZCBpcyBub3QgYWxsb3dlZFwiKTtcbiAgfVxuICBpZiAobmFtZSA9PT0gXCJcIikgcmV0dXJuIGZhaWwoXCJpcyBlbXB0eVwiKTtcbiAgaWYgKG5hbWUubGVuZ3RoID4gTUFYX0hPU1RfTEVOR1RIKSB7XG4gICAgcmV0dXJuIGZhaWwoYGlzIGxvbmdlciB0aGFuICR7TUFYX0hPU1RfTEVOR1RIfSBjaGFyYWN0ZXJzYCk7XG4gIH1cblxuICBjb25zdCBsYWJlbHMgPSBuYW1lLnNwbGl0KFwiLlwiKTtcbiAgaWYgKERJR0lUU19PTkxZLnRlc3QobGFiZWxzLmF0KC0xKSA/PyBcIlwiKSkge1xuICAgIHJldHVybiBmYWlsKFwiSVAgbGl0ZXJhbHMgYXJlIG5vdCBhbGxvd2VkXCIpO1xuICB9XG4gIGlmIChsYWJlbHMubGVuZ3RoIDwgMikgcmV0dXJuIGZhaWwoXCJtdXN0IGhhdmUgYXQgbGVhc3QgdHdvIGxhYmVsc1wiKTtcbiAgZm9yIChjb25zdCBsYWJlbCBvZiBsYWJlbHMpIHtcbiAgICBpZiAoXG4gICAgICAhTEFCRUxfUEFUVEVSTi50ZXN0KGxhYmVsKSB8fCBsYWJlbC5zdGFydHNXaXRoKFwiLVwiKSB8fCBsYWJlbC5lbmRzV2l0aChcIi1cIilcbiAgICApIHtcbiAgICAgIHJldHVybiBmYWlsKFwibXVzdCBiZSBhIGhvc3RuYW1lIG9yICouaG9zdG5hbWVcIik7XG4gICAgfVxuICB9XG4gIHJldHVybiB3aWxkY2FyZCA/IGAqLiR7bmFtZX1gIDogbmFtZTtcbn1cblxuLyoqXG4gKiBUaGUgaG9zdG5hbWUgb2YgYEFOVEhST1BJQ19CQVNFX1VSTGAsIG9yIHVuZGVmaW5lZCB3aGVuIGl0IG5hbWVzIG5vdGhpbmdcbiAqIGV4dGVybmFsICh1bnNldCwgYSBzaW5nbGUgbGFiZWwgc3VjaCBhcyBsb2NhbGhvc3Qgb3IgWzo6MV0sIG9yIGFuIElQdjRcbiAqIGxpdGVyYWwpLlxuICpcbiAqIEBwYXJhbSByYXcgLSBUaGUgZW52aXJvbm1lbnQgdmFsdWVcbiAqIEByZXR1cm5zIFRoZSBsb3dlci1jYXNlIGV4dGVybmFsIGhvc3RuYW1lLCBvciB1bmRlZmluZWRcbiAqIEB0aHJvd3MgRXJyb3IgbmFtaW5nIGBBTlRIUk9QSUNfQkFTRV9VUkxgIHdoZW4gdGhlIHZhbHVlIGlzIG5vdCBhIFVSTFxuICovXG5mdW5jdGlvbiBhbnRocm9waWNCYXNlVXJsSG9zdChyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IHZhbHVlID0gKHJhdyA/PyBcIlwiKS50cmltKCk7XG4gIGlmICh2YWx1ZSA9PT0gXCJcIikgcmV0dXJuIHVuZGVmaW5lZDtcblxuICBsZXQgaG9zdG5hbWU6IHN0cmluZztcbiAgdHJ5IHtcbiAgICBob3N0bmFtZSA9IG5ldyBVUkwodmFsdWUpLmhvc3RuYW1lO1xuICB9IGNhdGNoIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBTlRIUk9QSUNfQkFTRV9VUkwgaXMgbm90IGEgdmFsaWQgVVJMXCIpO1xuICB9XG4gIC8vIExvY2FsLCBub3QgZXh0ZXJuYWw6IGEgc2luZ2xlIGxhYmVsIChsb2NhbGhvc3QsIFs6OjFdKSBvciBhbiBJUHY0IGxpdGVyYWwuXG4gIGNvbnN0IGxhYmVscyA9IGhvc3RuYW1lLnNwbGl0KFwiLlwiKTtcbiAgaWYgKGxhYmVscy5sZW5ndGggPCAyIHx8IERJR0lUU19PTkxZLnRlc3QobGFiZWxzLmF0KC0xKSA/PyBcIlwiKSkge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgcmV0dXJuIGhvc3RuYW1lLnRvTG93ZXJDYXNlKCk7XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgZnVsbCwgZGUtZHVwbGljYXRlZCBlZ3Jlc3MgYWxsb3dsaXN0IGZvciB0aGlzIHdvcmtlci5cbiAqXG4gKiBAcGFyYW0gaW5wdXQgLSBFbmFibGVkIHByb3ZpZGVyIGlkcywgaW1nYmIgc3RhdGUsIGJhc2UgVVJMIGFuZCBvcGVyYXRvciBleHRyYXNcbiAqIEByZXR1cm5zIEhvc3RzIGluIG9yZGVyLCBmaXJzdCBvY2N1cnJlbmNlIHdpbnNcbiAqIEB0aHJvd3MgRXJyb3Igd2hlbiBgQU5USFJPUElDX0JBU0VfVVJMYCBpcyBub3QgYSBVUkwsIG9yIGFuIGV4dHJhIGlzIGludmFsaWRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVFZ3Jlc3NBbGxvd2xpc3QoaW5wdXQ6IHtcbiAgZW5hYmxlZFByb3ZpZGVySWRzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgaW1nYmJDb25maWd1cmVkOiBib29sZWFuO1xuICBhbnRocm9waWNCYXNlVXJsPzogc3RyaW5nO1xuICBleHRyYUhvc3RzPzogdW5rbm93bjtcbn0pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGhvc3RzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IGFkZCA9IChob3N0OiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICBpZiAoc2Vlbi5oYXMoaG9zdCkpIHJldHVybjtcbiAgICBzZWVuLmFkZChob3N0KTtcbiAgICBob3N0cy5wdXNoKGhvc3QpO1xuICB9O1xuICBjb25zdCBidWlsdGluRm9yID0gKHB1cnBvc2U6IEVncmVzc1B1cnBvc2UpOiB2b2lkID0+IHtcbiAgICBmb3IgKGNvbnN0IHJ1bGUgb2YgQlVJTFRJTl9FR1JFU1NfUlVMRVMpIHtcbiAgICAgIGlmIChydWxlLnB1cnBvc2UgPT09IHB1cnBvc2UpIGFkZChydWxlLmhvc3QpO1xuICAgIH1cbiAgfTtcblxuICBidWlsdGluRm9yKFwiZ2l0aHViXCIpO1xuICBmb3IgKGNvbnN0IGlkIG9mIGlucHV0LmVuYWJsZWRQcm92aWRlcklkcykge1xuICAgIGlmICghT2JqZWN0Lmhhc093bihQUk9WSURFUl9FR1JFU1NfUlVMRVMsIGlkKSkgY29udGludWU7XG4gICAgZm9yIChjb25zdCBydWxlIG9mIFBST1ZJREVSX0VHUkVTU19SVUxFU1tpZF0gPz8gW10pIGFkZChydWxlLmhvc3QpO1xuICB9XG4gIGlmIChpbnB1dC5pbWdiYkNvbmZpZ3VyZWQpIHtcbiAgICBmb3IgKGNvbnN0IHJ1bGUgb2YgSU1HQkJfRUdSRVNTX1JVTEVTKSBhZGQocnVsZS5ob3N0KTtcbiAgfVxuICBidWlsdGluRm9yKFwicmVnaXN0cnlcIik7XG5cbiAgY29uc3QgYmFzZUhvc3QgPSBhbnRocm9waWNCYXNlVXJsSG9zdChpbnB1dC5hbnRocm9waWNCYXNlVXJsKTtcbiAgaWYgKGJhc2VIb3N0ICE9PSB1bmRlZmluZWQpIGFkZChiYXNlSG9zdCk7XG5cbiAgaWYgKGlucHV0LmV4dHJhSG9zdHMgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmICghQXJyYXkuaXNBcnJheShpbnB1dC5leHRyYUhvc3RzKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiZWdyZXNzX2FsbG93X2hvc3RzIG11c3QgYmUgYW4gYXJyYXkgb2YgaG9zdG5hbWVzXCIpO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGlucHV0LmV4dHJhSG9zdHMpIGFkZCh2YWxpZGF0ZUVncmVzc0hvc3QoZW50cnkpKTtcbiAgfVxuXG4gIHJldHVybiBob3N0cztcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7O0NBZUMsR0FFRCxTQUNFLGtCQUFrQixFQUNsQixpQkFBaUIsRUFDakIsb0JBQW9CLEVBQ3BCLGtCQUFrQixRQUNiLHNCQUFzQjtBQUM3QixTQUFTLDJCQUEyQixRQUFRLG9CQUFvQjtBQWFoRSxNQUFNLGdCQUFnQixJQUFJLElBQUksNkJBQTZCLFFBQVE7QUFFbkUsc0VBQXNFLEdBQ3RFLE9BQU8sTUFBTSx1QkFBa0Q7RUFDN0QsU0FBUztFQUNUO0lBQ0UsTUFBTTtJQUNOLFNBQVM7SUFDVCxRQUFRO0VBQ1Y7RUFDQTtJQUNFLE1BQU07SUFDTixTQUFTO0lBQ1QsUUFBUTtFQUNWO0VBQ0E7SUFDRSxNQUFNO0lBQ04sU0FBUztJQUNULFFBQVE7RUFDVjtFQUNBO0lBQ0UsTUFBTTtJQUNOLFNBQVM7SUFDVCxRQUFRO0VBQ1Y7RUFDQTtJQUNFLE1BQU07SUFDTixTQUFTO0lBQ1QsUUFBUTtFQUNWO0VBQ0E7SUFDRSxNQUFNO0lBQ04sU0FBUztJQUNULFFBQVE7RUFDVjtFQUNBLHVFQUF1RTtFQUN2RSxxRUFBcUU7RUFDckUsc0VBQXNFO0VBQ3RFLG9FQUFvRTtFQUNwRSxnR0FBZ0c7S0FDN0YsQUFBQztJQUFDO01BQUM7TUFBRztLQUFHO0lBQUU7TUFBQztNQUFJO0tBQUc7SUFBRTtNQUFDO01BQUs7S0FBSTtHQUFDLENBQVcsT0FBTyxDQUFDLENBQUMsQ0FBQyxPQUFPLEtBQUssR0FDbEUsTUFBTSxJQUFJLENBQUM7TUFBRSxRQUFRLE9BQU8sUUFBUTtJQUFFLEdBQUcsQ0FBQyxHQUFHLFNBQTJCLENBQUM7UUFDdkUsTUFBTSxDQUFDLG1CQUFtQixFQUFFLFFBQVEsT0FBTyxzQkFBc0IsQ0FBQztRQUNsRSxTQUFTO1FBQ1QsUUFBUTtNQUNWLENBQUM7RUFFSCxxQkFBcUI7RUFDckI7SUFDRSxNQUFNO0lBQ04sU0FBUztJQUNULFFBQVE7RUFDVjtFQUNBO0lBQ0UsTUFBTTtJQUNOLFNBQVM7SUFDVCxRQUFRO0VBQ1Y7RUFDQTtJQUNFLE1BQU07SUFDTixTQUFTO0lBQ1QsUUFBUTtFQUNWO0VBQ0E7SUFDRSxxRUFBcUU7SUFDckUsMERBQTBEO0lBQzFELE1BQU07SUFDTixTQUFTO0lBQ1QsUUFBUTtFQUNWO0VBQ0E7SUFDRSxzRUFBc0U7SUFDdEUsd0VBQXdFO0lBQ3hFLE1BQU07SUFDTixTQUFTO0lBQ1QsUUFBUTtFQUNWO0VBQ0E7SUFDRSxNQUFNO0lBQ04sU0FBUztJQUNULFFBQVE7RUFDVjtFQUNBO0lBQ0UsTUFBTTtJQUNOLFNBQVM7SUFDVCxRQUFRO0VBQ1Y7RUFDQTtJQUNFLE1BQU07SUFDTixTQUFTO0lBQ1QsUUFBUTtFQUNWO0VBQ0E7SUFDRSxNQUFNO0lBQ04sU0FBUztJQUNULFFBQVE7RUFDVjtFQUNBO0lBQ0UsTUFBTTtJQUNOLFNBQVM7SUFDVCxRQUFRO0VBQ1Y7RUFDQTtJQUNFLE1BQU07SUFDTixTQUFTO0lBQ1QsUUFBUTtFQUNWO0VBQ0E7SUFDRSxNQUFNO0lBQ04sU0FBUztJQUNULFFBQVE7RUFDVjtFQUNBO0lBQ0Usd0VBQXdFO0lBQ3hFLHdFQUF3RTtJQUN4RSxNQUFNO0lBQ04sU0FBUztJQUNULFFBQVE7RUFDVjtDQUNELENBQUM7QUFFRix5REFBeUQsR0FDekQsT0FBTyxNQUFNLHdCQUVUO0VBQ0YsQ0FBQyxtQkFBbUIsRUFBRTtJQUNwQjtNQUNFLE1BQU07TUFDTixTQUFTO01BQ1QsVUFBVTtNQUNWLFFBQVE7SUFDVjtJQUNBO01BQ0UsTUFBTTtNQUNOLFNBQVM7TUFDVCxVQUFVO01BQ1YsUUFBUTtJQUNWO0lBQ0E7TUFDRSxNQUFNO01BQ04sU0FBUztNQUNULFVBQVU7TUFDVixRQUFRO0lBQ1Y7R0FDRDtFQUNELENBQUMsa0JBQWtCLEVBQUU7SUFDbkI7TUFDRSxNQUFNO01BQ04sU0FBUztNQUNULFVBQVU7TUFDVixRQUFRO0lBQ1Y7SUFDQTtNQUNFLE1BQU07TUFDTixTQUFTO01BQ1QsVUFBVTtNQUNWLFFBQVE7SUFDVjtJQUNBO01BQ0UsTUFBTTtNQUNOLFNBQVM7TUFDVCxVQUFVO01BQ1YsUUFBUTtJQUNWO0lBQ0E7TUFDRSxNQUFNO01BQ04sU0FBUztNQUNULFVBQVU7TUFDVixRQUFRO0lBQ1Y7SUFDQTtNQUNFLE1BQU07TUFDTixTQUFTO01BQ1QsVUFBVTtNQUNWLFFBQ0U7SUFDSjtHQUNEO0VBQ0QsQ0FBQyxtQkFBbUIsRUFBRTtJQUNwQjtNQUNFLE1BQU07TUFDTixTQUFTO01BQ1QsVUFBVTtNQUNWLFFBQVE7SUFDVjtJQUNBO01BQ0UsTUFBTTtNQUNOLFNBQVM7TUFDVCxVQUFVO01BQ1YsUUFBUTtJQUNWO0lBQ0E7TUFDRSxNQUFNO01BQ04sU0FBUztNQUNULFVBQVU7TUFDVixRQUFRO0lBQ1Y7R0FDRDtFQUNELENBQUMscUJBQXFCLEVBQUU7SUFDdEI7TUFDRSxNQUFNO01BQ04sU0FBUztNQUNULFVBQVU7TUFDVixRQUFRO0lBQ1Y7R0FDRDtBQUNILEVBQUU7QUFFRixtREFBbUQsR0FDbkQsT0FBTyxNQUFNLHFCQUFnRDtFQUMzRDtJQUNFLE1BQU07SUFDTixTQUFTO0lBQ1QsUUFBUTtFQUNWO0NBQ0QsQ0FBQztBQUVGLE1BQU0sY0FBYztBQUNwQixNQUFNLGtCQUFrQjtBQUN4QixNQUFNLGdCQUFnQjtBQUN0QixNQUFNLGNBQWM7QUFDcEIsTUFBTSx3QkFBd0I7QUFFOUI7Ozs7OztDQU1DLEdBQ0QsT0FBTyxTQUFTLG1CQUFtQixLQUFjO0VBQy9DLE1BQU0sT0FBTyxDQUFDO0lBQ1osTUFBTSxJQUFJLE1BQ1IsQ0FBQyx5QkFBeUIsRUFDeEIsS0FBSyxTQUFTLENBQUMsT0FDaEIsc0JBQXNCLEVBQUUsS0FBSztFQUVsQztFQUNBLElBQUksT0FBTyxVQUFVLFVBQVUsT0FBTyxLQUFLO0VBQzNDLElBQUksVUFBVSxJQUFJLE9BQU8sS0FBSztFQUM5QixJQUFJLHNCQUFzQixJQUFJLENBQUMsUUFBUTtJQUNyQyxPQUFPLEtBQUs7RUFDZDtFQUVBLElBQUksT0FBTyxNQUFNLFdBQVc7RUFDNUIsTUFBTSxRQUFRLEtBQUssT0FBTyxDQUFDO0VBQzNCLElBQUksVUFBVSxDQUFDLEdBQUc7SUFDaEIsTUFBTSxPQUFPLEtBQUssS0FBSyxDQUFDLFFBQVE7SUFDaEMsSUFBSSxTQUFTLGFBQWE7TUFDeEIsT0FBTyxLQUNMLFlBQVksSUFBSSxDQUFDLFFBQ2IsNkJBQ0E7SUFFUjtJQUNBLE9BQU8sS0FBSyxLQUFLLENBQUMsR0FBRztFQUN2QjtFQUVBLE1BQU0sV0FBVyxLQUFLLFVBQVUsQ0FBQztFQUNqQyxNQUFNLE9BQU8sV0FBVyxLQUFLLEtBQUssQ0FBQyxLQUFLO0VBQ3hDLElBQUksU0FBUyxPQUFRLFlBQVksU0FBUyxJQUFLO0lBQzdDLE9BQU8sS0FBSztFQUNkO0VBQ0EsSUFBSSxTQUFTLElBQUksT0FBTyxLQUFLO0VBQzdCLElBQUksS0FBSyxNQUFNLEdBQUcsaUJBQWlCO0lBQ2pDLE9BQU8sS0FBSyxDQUFDLGVBQWUsRUFBRSxnQkFBZ0IsV0FBVyxDQUFDO0VBQzVEO0VBRUEsTUFBTSxTQUFTLEtBQUssS0FBSyxDQUFDO0VBQzFCLElBQUksWUFBWSxJQUFJLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQyxNQUFNLEtBQUs7SUFDekMsT0FBTyxLQUFLO0VBQ2Q7RUFDQSxJQUFJLE9BQU8sTUFBTSxHQUFHLEdBQUcsT0FBTyxLQUFLO0VBQ25DLEtBQUssTUFBTSxTQUFTLE9BQVE7SUFDMUIsSUFDRSxDQUFDLGNBQWMsSUFBSSxDQUFDLFVBQVUsTUFBTSxVQUFVLENBQUMsUUFBUSxNQUFNLFFBQVEsQ0FBQyxNQUN0RTtNQUNBLE9BQU8sS0FBSztJQUNkO0VBQ0Y7RUFDQSxPQUFPLFdBQVcsQ0FBQyxFQUFFLEVBQUUsTUFBTSxHQUFHO0FBQ2xDO0FBRUE7Ozs7Ozs7O0NBUUMsR0FDRCxTQUFTLHFCQUFxQixHQUF1QjtFQUNuRCxNQUFNLFFBQVEsQ0FBQyxPQUFPLEVBQUUsRUFBRSxJQUFJO0VBQzlCLElBQUksVUFBVSxJQUFJLE9BQU87RUFFekIsSUFBSTtFQUNKLElBQUk7SUFDRixXQUFXLElBQUksSUFBSSxPQUFPLFFBQVE7RUFDcEMsRUFBRSxPQUFNO0lBQ04sTUFBTSxJQUFJLE1BQU07RUFDbEI7RUFDQSw2RUFBNkU7RUFDN0UsTUFBTSxTQUFTLFNBQVMsS0FBSyxDQUFDO0VBQzlCLElBQUksT0FBTyxNQUFNLEdBQUcsS0FBSyxZQUFZLElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDLE1BQU0sS0FBSztJQUM5RCxPQUFPO0VBQ1Q7RUFDQSxPQUFPLFNBQVMsV0FBVztBQUM3QjtBQUVBOzs7Ozs7Q0FNQyxHQUNELE9BQU8sU0FBUyx1QkFBdUIsS0FLdEM7RUFDQyxNQUFNLFFBQWtCLEVBQUU7RUFDMUIsTUFBTSxPQUFPLElBQUk7RUFDakIsTUFBTSxNQUFNLENBQUM7SUFDWCxJQUFJLEtBQUssR0FBRyxDQUFDLE9BQU87SUFDcEIsS0FBSyxHQUFHLENBQUM7SUFDVCxNQUFNLElBQUksQ0FBQztFQUNiO0VBQ0EsTUFBTSxhQUFhLENBQUM7SUFDbEIsS0FBSyxNQUFNLFFBQVEscUJBQXNCO01BQ3ZDLElBQUksS0FBSyxPQUFPLEtBQUssU0FBUyxJQUFJLEtBQUssSUFBSTtJQUM3QztFQUNGO0VBRUEsV0FBVztFQUNYLEtBQUssTUFBTSxNQUFNLE1BQU0sa0JBQWtCLENBQUU7SUFDekMsSUFBSSxDQUFDLE9BQU8sTUFBTSxDQUFDLHVCQUF1QixLQUFLO0lBQy9DLEtBQUssTUFBTSxRQUFRLHFCQUFxQixDQUFDLEdBQUcsSUFBSSxFQUFFLENBQUUsSUFBSSxLQUFLLElBQUk7RUFDbkU7RUFDQSxJQUFJLE1BQU0sZUFBZSxFQUFFO0lBQ3pCLEtBQUssTUFBTSxRQUFRLG1CQUFvQixJQUFJLEtBQUssSUFBSTtFQUN0RDtFQUNBLFdBQVc7RUFFWCxNQUFNLFdBQVcscUJBQXFCLE1BQU0sZ0JBQWdCO0VBQzVELElBQUksYUFBYSxXQUFXLElBQUk7RUFFaEMsSUFBSSxNQUFNLFVBQVUsS0FBSyxXQUFXO0lBQ2xDLElBQUksQ0FBQyxNQUFNLE9BQU8sQ0FBQyxNQUFNLFVBQVUsR0FBRztNQUNwQyxNQUFNLElBQUksTUFBTTtJQUNsQjtJQUNBLEtBQUssTUFBTSxTQUFTLE1BQU0sVUFBVSxDQUFFLElBQUksbUJBQW1CO0VBQy9EO0VBRUEsT0FBTztBQUNUIn0=
// denoCacheMetadata=13024375486575556358,15113157171639957349