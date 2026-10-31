/**
 * Egress self-check classification (Issue #4048).
 *
 * Probe results are injected. Nothing here opens a socket.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { egressSelfcheckCommand } from "../commands/egress_selfcheck.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  checkEgressPolicy,
  classifyEgressProbes,
  decideEgressPolicy,
  EGRESS_NOT_ENFORCED_MARKER,
  EGRESS_SELFCHECK_EXIT_STATUS,
  EGRESS_SELFCHECK_FAILURE_MARKER,
  type EgressProbeResults,
  type EgressVerdict,
  egressVerdictPassed,
  formatEgressPolicyRecord,
} from "../lib/egress_selfcheck.ts";

const DATE = "2026-10-26";

const enforcedProbes: EgressProbeResults = {
  directCloudflare: "refused",
  directGithub: "refused",
  proxyDenied: "denied",
  proxyAllowed: "succeeded",
};

function probes(over: Partial<EgressProbeResults>): EgressProbeResults {
  return { ...enforcedProbes, ...over };
}

Deno.test("classifyEgressProbes - the four-probe success is the only enforced verdict", () => {
  assertEquals(classifyEgressProbes(enforcedProbes), "enforced");
  assertEquals(egressVerdictPassed("enforced"), true);
  for (
    const verdict of [
      "unenforced",
      "proxy_unavailable",
      "not_checked",
      "not_enforced",
    ] as const
  ) {
    assertEquals(egressVerdictPassed(verdict), false);
  }
});

Deno.test("classifyEgressProbes - a direct or denied connection that got through is unenforced", () => {
  assertEquals(
    classifyEgressProbes(probes({ directCloudflare: "connected" })),
    "unenforced",
  );
  assertEquals(
    classifyEgressProbes(probes({ directGithub: "connected" })),
    "unenforced",
  );
  assertEquals(
    classifyEgressProbes(probes({ proxyDenied: "through" })),
    "unenforced",
  );
  // A hole beats a probe that could not run.
  assertEquals(
    classifyEgressProbes(probes({
      directCloudflare: "connected",
      proxyAllowed: "not_checked",
    })),
    "unenforced",
  );
});

Deno.test("classifyEgressProbes - an allowlisted CONNECT that failed is proxy_unavailable", () => {
  assertEquals(
    classifyEgressProbes(probes({ proxyAllowed: "failed" })),
    "proxy_unavailable",
  );
  assertEquals(egressVerdictPassed("proxy_unavailable"), false);
});

Deno.test("classifyEgressProbes - a probe that could not run is not_checked and never enforced", () => {
  for (
    const over of [
      { directCloudflare: "not_checked" as const },
      { directGithub: "not_checked" as const },
      { proxyDenied: "not_checked" as const },
      { proxyAllowed: "not_checked" as const },
    ]
  ) {
    const verdict = classifyEgressProbes(probes(over));
    assertEquals(verdict, "not_checked");
    assertEquals(egressVerdictPassed(verdict), false);
  }
});

Deno.test("decideEgressPolicy - an enforcing runtime exits on every verdict except enforced", () => {
  const cases: Array<{ probes: EgressProbeResults; verdict: EgressVerdict }> = [
    { probes: enforcedProbes, verdict: "enforced" },
    {
      probes: probes({ directCloudflare: "connected" }),
      verdict: "unenforced",
    },
    {
      probes: probes({ proxyAllowed: "failed" }),
      verdict: "proxy_unavailable",
    },
    {
      probes: probes({ proxyDenied: "not_checked" }),
      verdict: "not_checked",
    },
  ];
  for (const item of cases) {
    const decision = decideEgressPolicy({
      flag: "true",
      dialect: "docker",
      version: "27.1.1",
      date: DATE,
      probes: item.probes,
    });
    assertEquals(decision.verdict, item.verdict);
    assertEquals(decision.passed, item.verdict === "enforced");
    if (item.verdict === "enforced") {
      assertEquals(decision.exitCode, 0);
      assertEquals(decision.marker, undefined);
    } else {
      assertEquals(decision.exitCode, EGRESS_SELFCHECK_EXIT_STATUS);
      assert(
        decision.marker?.startsWith(EGRESS_SELFCHECK_FAILURE_MARKER),
        decision.marker,
      );
    }
    assertEquals(decision.record.includes("runtime=docker"), true);
    assertEquals(decision.record.includes("version=27.1.1"), true);
    assertEquals(decision.record.includes(`date=${DATE}`), true);
    assertEquals(
      decision.record.startsWith(`egress policy: ${item.verdict} `),
      true,
    );
  }
});

Deno.test("decideEgressPolicy - a non-enforcing dialect warns and continues", () => {
  const decision = decideEgressPolicy({
    flag: "false",
    dialect: "apple-container",
    version: "unknown",
    date: DATE,
  });
  assertEquals(decision.verdict, "not_enforced");
  assertEquals(decision.passed, false);
  assertEquals(decision.exitCode, 0);
  assertEquals(decision.marker, undefined);
  assertEquals(
    decision.warning,
    `${EGRESS_NOT_ENFORCED_MARKER} dialect=apple-container`,
  );
  assertEquals(
    decision.record,
    "egress policy: not_enforced runtime=apple-container version=unknown date=2026-10-26",
  );
});

Deno.test("decideEgressPolicy - an absent flag records not_enforced and does not warn", () => {
  const decision = decideEgressPolicy({
    flag: "absent",
    dialect: "unspecified",
    version: "unknown",
    date: DATE,
  });
  assertEquals(decision.verdict, "not_enforced");
  assertEquals(decision.exitCode, 0);
  assertEquals(decision.warning, undefined);
  assertEquals(decision.passed, false);
});

Deno.test("checkEgressPolicy - injected probes do not require a flag-true runner", async () => {
  const decision = await checkEgressPolicy({
    env: (name) =>
      ({
        VIBE_EGRESS_ENFORCED: "true",
        VIBE_RUNTIME_KIND: "podman",
        VIBE_RUNTIME_VERSION: "5.2",
      })[name],
    probes: probes({ proxyAllowed: "failed" }),
    date: DATE,
    probe: () => {
      throw new Error("injected probes must not call the runner");
    },
  });
  assertEquals(decision.verdict, "proxy_unavailable");
  assertEquals(decision.exitCode, EGRESS_SELFCHECK_EXIT_STATUS);
});

Deno.test("checkEgressPolicy - a false flag does not run probes", async () => {
  const decision = await checkEgressPolicy({
    env: (name) =>
      ({
        VIBE_EGRESS_ENFORCED: "false",
        VIBE_RUNTIME_KIND: "apple-container",
      })[name],
    date: DATE,
    probe: () => {
      throw new Error("a non-enforcing dialect must not probe");
    },
  });
  assertEquals(decision.verdict, "not_enforced");
  assertEquals(decision.exitCode, 0);
  assert(decision.warning?.includes("apple-container"));
});

Deno.test("egress-selfcheck - emits warnings with warn and failures with error", async () => {
  const warnings: string[] = [];
  const errors: string[] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalLog = console.log;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  console.log = () => {};
  try {
    const seams = {
      env: (name: string) =>
        ({
          VIBE_EGRESS_ENFORCED: "false",
          VIBE_RUNTIME_KIND: "apple-container",
          VIBE_APPLE_EGRESS_MODE: "internal",
          VIBE_RUNTIME_VERSION: "1.2.2",
          VIBE_EGRESS_MACOS_VERSION: "27.0.1",
        })[name],
      probes: probes({ proxyAllowed: "succeeded" }),
      appleObserved: { ipv4: "refused", host: "connected" },
      appleControl: { ipv4: "connected", host: "connected" },
    };
    const config = buildDefaultWorkerConfig();
    const healthy = await egressSelfcheckCommand.execute({}, config, seams);
    assertEquals(healthy.success, true);
    assert(warnings.some((line) => line.includes(EGRESS_NOT_ENFORCED_MARKER)));
    assertEquals(
      errors.some((line) => line.includes(EGRESS_NOT_ENFORCED_MARKER)),
      false,
    );

    warnings.length = 0;
    errors.length = 0;
    const broken = await egressSelfcheckCommand.execute(
      {},
      config,
      { ...seams, probes: probes({ proxyAllowed: "failed" }) },
    );
    assertEquals(broken.success, false);
    assertEquals(
      warnings.some((line) => line.includes(EGRESS_NOT_ENFORCED_MARKER)),
      true,
    );
    assert(
      errors.some((line) => line.includes(EGRESS_SELFCHECK_FAILURE_MARKER)),
    );
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
    console.log = originalLog;
  }
});

Deno.test("formatEgressPolicyRecord - refuses a field that is not one token", () => {
  assertThrows(() =>
    formatEgressPolicyRecord({
      verdict: "enforced",
      runtime: "docker",
      version: "has space",
      date: DATE,
    })
  );
  assertThrows(() =>
    formatEgressPolicyRecord({
      verdict: "enforced",
      runtime: "docker",
      version: "27",
      date: "26 Oct 2026",
    })
  );
});
