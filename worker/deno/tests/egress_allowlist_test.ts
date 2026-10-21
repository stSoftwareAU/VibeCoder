import { assertEquals, assertThrows } from "@std/assert";
import {
  resolveEgressAllowlist,
  validateEgressHost,
} from "../lib/egress_allowlist.ts";
import { assertLinearGrowth } from "./support/growth.ts";

const GITHUB_HOSTS = [
  "github.com",
  "api.github.com",
  "uploads.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
];

const REGISTRY_HOSTS = [
  "registry.npmjs.org",
  "jsr.io",
  "deno.land",
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "pypi.org",
  "files.pythonhosted.org",
  "static.rust-lang.org",
  "cdn.playwright.dev",
];

const PROVIDER_HOSTS: Readonly<Record<string, string[]>> = {
  claude: [
    "api.anthropic.com",
    "console.anthropic.com",
    "platform.claude.com",
  ],
  codex: ["api.openai.com", "auth.openai.com", "chatgpt.com"],
  gemini: [
    "generativelanguage.googleapis.com",
    "cloudcode-pa.googleapis.com",
    "oauth2.googleapis.com",
  ],
  deepseek: ["api.deepseek.com"],
};

const ALL_PROVIDER_HOSTS = Object.values(PROVIDER_HOSTS).flat();

const BASE_ONLY = [...GITHUB_HOSTS, ...REGISTRY_HOSTS];

Deno.test("resolveEgressAllowlist - a disabled provider contributes no hosts (Issue #4045)", () => {
  const withClaude = resolveEgressAllowlist({
    enabledProviderIds: ["claude"],
    imgbbConfigured: false,
  });
  for (const [id, hosts] of Object.entries(PROVIDER_HOSTS)) {
    if (id === "claude") continue;
    for (const host of hosts) {
      assertEquals(withClaude.includes(host), false, `${id} host ${host}`);
    }
  }

  const withNone = resolveEgressAllowlist({
    enabledProviderIds: [],
    imgbbConfigured: false,
  });
  for (const host of ALL_PROVIDER_HOSTS) {
    assertEquals(withNone.includes(host), false, host);
  }
});

Deno.test("resolveEgressAllowlist - each enabled provider contributes exactly its documented hosts (Issue #4045)", () => {
  const base = resolveEgressAllowlist({
    enabledProviderIds: [],
    imgbbConfigured: false,
  });
  for (const [id, hosts] of Object.entries(PROVIDER_HOSTS)) {
    const withProvider = resolveEgressAllowlist({
      enabledProviderIds: [id],
      imgbbConfigured: false,
    });
    const added = withProvider.filter((host) => !base.includes(host));
    assertEquals([...added].sort(), [...hosts].sort(), `provider ${id}`);
  }
});

Deno.test("resolveEgressAllowlist - an unknown provider id contributes nothing (Issue #4045)", () => {
  const out = resolveEgressAllowlist({
    enabledProviderIds: ["no-such-provider", "constructor", "__proto__"],
    imgbbConfigured: false,
  });
  assertEquals(out, BASE_ONLY);
});

Deno.test("resolveEgressAllowlist - api.imgbb.com is present iff imgbb is configured (Issue #4045)", () => {
  const on = resolveEgressAllowlist({
    enabledProviderIds: [],
    imgbbConfigured: true,
  });
  assertEquals(on.includes("api.imgbb.com"), true);

  const off = resolveEgressAllowlist({
    enabledProviderIds: [],
    imgbbConfigured: false,
  });
  assertEquals(off.includes("api.imgbb.com"), false);
});

Deno.test("resolveEgressAllowlist - GitHub and registry hosts are always present, in order (Issue #4045)", () => {
  const out = resolveEgressAllowlist({
    enabledProviderIds: [],
    imgbbConfigured: false,
  });
  assertEquals(out, [...GITHUB_HOSTS, ...REGISTRY_HOSTS]);

  const all = resolveEgressAllowlist({
    enabledProviderIds: Object.keys(PROVIDER_HOSTS),
    imgbbConfigured: true,
  });
  for (const host of [...GITHUB_HOSTS, ...REGISTRY_HOSTS]) {
    assertEquals(all.includes(host), true, host);
  }
});

Deno.test("resolveEgressAllowlist - ANTHROPIC_BASE_URL host is added, lower-cased (Issue #4045)", () => {
  const out = resolveEgressAllowlist({
    enabledProviderIds: [],
    imgbbConfigured: false,
    anthropicBaseUrl: "https://llm-gateway.example.com/v1",
  });
  assertEquals(out, [...BASE_ONLY, "llm-gateway.example.com"]);

  const upper = resolveEgressAllowlist({
    enabledProviderIds: [],
    imgbbConfigured: false,
    anthropicBaseUrl: "https://LLM-Gateway.Example.com/v1",
  });
  assertEquals(upper, [...BASE_ONLY, "llm-gateway.example.com"]);
});

Deno.test("resolveEgressAllowlist - an empty or unset ANTHROPIC_BASE_URL adds nothing (Issue #4045)", () => {
  for (const anthropicBaseUrl of [undefined, "", "   "]) {
    const out = resolveEgressAllowlist({
      enabledProviderIds: [],
      imgbbConfigured: false,
      anthropicBaseUrl,
    });
    assertEquals(out, BASE_ONLY, String(anthropicBaseUrl));
  }
});

Deno.test("resolveEgressAllowlist - local ANTHROPIC_BASE_URL values add nothing (Issue #4045)", () => {
  for (
    const anthropicBaseUrl of [
      "https://localhost:8443",
      "http://127.0.0.1:8080",
      "http://[::1]:3000",
      "http://proxy:8080",
    ]
  ) {
    const out = resolveEgressAllowlist({
      enabledProviderIds: [],
      imgbbConfigured: false,
      anthropicBaseUrl,
    });
    assertEquals(out, BASE_ONLY, anthropicBaseUrl);
  }
});

Deno.test("resolveEgressAllowlist - an unparseable ANTHROPIC_BASE_URL throws naming it (Issue #4045)", () => {
  assertThrows(
    () =>
      resolveEgressAllowlist({
        enabledProviderIds: [],
        imgbbConfigured: false,
        anthropicBaseUrl: "not a url",
      }),
    Error,
    "ANTHROPIC_BASE_URL",
  );
});

Deno.test("resolveEgressAllowlist - operator extras are appended after the base URL host (Issue #4045)", () => {
  const out = resolveEgressAllowlist({
    enabledProviderIds: [],
    imgbbConfigured: false,
    anthropicBaseUrl: "https://llm-gateway.example.com/v1",
    extraHosts: ["example.org", "*.example.net"],
  });
  assertEquals(out, [
    ...BASE_ONLY,
    "llm-gateway.example.com",
    "example.org",
    "*.example.net",
  ]);
});

Deno.test("resolveEgressAllowlist - duplicates collapse to one entry each, first occurrence wins (Issue #4045)", () => {
  const out = resolveEgressAllowlist({
    enabledProviderIds: [],
    imgbbConfigured: false,
    anthropicBaseUrl: "https://llm-gateway.example.com/v1",
    extraHosts: [
      "github.com",
      "example.org",
      "example.org",
      "GitHub.com",
      "llm-gateway.example.com",
    ],
  });
  assertEquals(out, [...BASE_ONLY, "llm-gateway.example.com", "example.org"]);
  for (const host of ["github.com", "example.org", "llm-gateway.example.com"]) {
    assertEquals(out.filter((h) => h === host).length, 1, host);
  }
  assertEquals(new Set(out).size, out.length);
});

Deno.test("resolveEgressAllowlist - non-array egress_allow_hosts throws (Issue #4045)", () => {
  assertThrows(
    () =>
      resolveEgressAllowlist({
        enabledProviderIds: [],
        imgbbConfigured: false,
        extraHosts: "github.com",
      }),
    Error,
    "egress_allow_hosts",
  );
});

Deno.test("validateEgressHost - accepts hostnames, lower-cases, strips :443, keeps wildcard (Issue #4045)", () => {
  assertEquals(validateEgressHost("example.com"), "example.com");
  assertEquals(validateEgressHost("Example.COM"), "example.com");
  assertEquals(validateEgressHost("example.com:443"), "example.com");
  assertEquals(validateEgressHost("*.example.com"), "*.example.com");
});

Deno.test("validateEgressHost - rejects invalid entries, naming the entry (Issue #4045)", () => {
  const rejected: unknown[] = [
    "1.2.3.4",
    "*",
    "example.com:22",
    "",
    "a b",
    "a\nb",
    "\tex.com",
    "localhost",
    "*.",
    "*.com",
    "[::1]",
    "-bad.com",
    "a..b",
    "a".repeat(64) + ".com",
    42,
    "example.com:",
    "http://example.com",
  ];
  for (const entry of rejected) {
    assertThrows(
      () => validateEgressHost(entry),
      Error,
      JSON.stringify(entry),
    );
  }
});

/** A run that is true only when the input is rejected for `reason`. */
function rejectsFor(reason: string): (input: string) => boolean {
  return (input) => {
    try {
      validateEgressHost(input);
      return false;
    } catch (error) {
      return error instanceof Error && error.message.includes(reason);
    }
  };
}

// Inputs stay within MAX_HOST_LENGTH (253) at the largest size (4 x 50 = 200).
Deno.test("validateEgressHost - a long label run reaches LABEL_PATTERN and is rejected in linear time (Issue #4045)", () => {
  const result = assertLinearGrowth(
    "validateEgressHost, hostile label run",
    (chars) => "a".repeat(chars) + "!.com",
    rejectsFor("must be a hostname or *.hostname"),
    { baseChars: 50 },
  );
  assertEquals(result, true);
});

Deno.test("validateEgressHost - a long digit run reaches DIGITS_ONLY and is rejected in linear time (Issue #4045)", () => {
  // Ends in a digit run, not a letter, so the last label is all digits.
  const result = assertLinearGrowth(
    "validateEgressHost, hostile digit run",
    (chars) => "a." + "1".repeat(chars),
    rejectsFor("IP literals are not allowed"),
    { baseChars: 50 },
  );
  assertEquals(result, true);
});

Deno.test("validateEgressHost - a long control-character run reaches WHITESPACE_OR_CONTROL and is rejected in linear time (Issue #4045)", () => {
  const result = assertLinearGrowth(
    "validateEgressHost, hostile control run",
    (chars) => "a".repeat(chars) + "\u0001",
    rejectsFor("contains whitespace or a control character"),
    { baseChars: 50 },
  );
  assertEquals(result, true);
});

Deno.test("validateEgressHost - error message explains the rejection (Issue #4045)", () => {
  assertThrows(
    () => validateEgressHost("1.2.3.4"),
    Error,
    "IP literals are not allowed",
  );
  assertThrows(
    () => validateEgressHost("example.com:22"),
    Error,
    "only port 443 is allowed",
  );
});
