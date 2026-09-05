/**
 * The launchers park a host whose containers cannot reach the network
 * (Issue #997).
 *
 * Driven end to end: the real launcher runs under the harness with a stubbed
 * probe reporting each of the three conditions, and the assertions are the
 * complaint from the incident on GRQ-23 (#991) turned round — the escalation
 * names the host-networking fault and not `image_build`, it carries the hop
 * evidence, the host parks instead of rebuilding, and a link outage waits
 * instead of calling a human.
 *
 * `run.ps1` is held to the same behaviour wherever PowerShell is installed, so
 * a Windows host cannot drift into rebuilding what a macOS host parks.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  BASH_LAUNCHER,
  buildCount,
  denoInvocationOrder,
  type Harness,
  type LauncherInvocation,
  type LaunchOutcome,
  launchPhaseMarker,
  POWERSHELL_LAUNCHER,
  recorded,
  recordedLaunchLog,
  runCoreLog,
  runLauncher,
  setupHarness,
} from "./fixtures/launcher_harness.ts";
import {
  HOST_EGRESS_BLOCKED_EXIT_STATUS,
} from "../lib/container_egress_probe.ts";
import {
  EGRESS_BLOCKED_EXIT,
  NETWORK_DOWN_EXIT,
} from "../commands/container_egress_probe.ts";
import { isNetworkUnavailableLaunch } from "../lib/container_restart_backoff.ts";
import { NETWORK_UNAVAILABLE_MARKER } from "../lib/github_user_resolution.ts";
import { executableLines } from "../lib/launcher_source.ts";

/** The evidence a blocked host's probe writes, as the real command does. */
const BLOCKED_EVIDENCE = [
  "Container egress probe: egress_blocked",
  "| hop | result |",
  "| container → 1.1.1.1:443 | FAIL — connect: no route to host |",
  "| host → 1.1.1.1:443 | OK |",
  "Host routing table (netstat -rn):",
  "- reject route(s): default link#22 UCSIg bridge100 !",
  "- tunnel interface holding a default route: default 100.100.100.100 UGScIg utun8",
].join("\\n");

/** What the probe writes when the host cannot reach the address either. */
const NETWORK_DOWN_EVIDENCE = [
  "Container egress probe: network_down",
  "| container → 1.1.1.1:443 | FAIL |",
  "| host → 1.1.1.1:443 | FAIL — no answer within 8s |",
  NETWORK_UNAVAILABLE_MARKER,
].join("\\n");

const LAUNCHERS: LauncherInvocation[] = [
  BASH_LAUNCHER,
  ...(POWERSHELL_LAUNCHER ? [POWERSHELL_LAUNCHER] : []),
];

async function withHarness(
  env: Record<string, string>,
  body: (harness: Harness, outcome: LaunchOutcome) => Promise<void>,
  launcher: LauncherInvocation,
): Promise<void> {
  const harness = await setupHarness(env, { denoStub: true });
  try {
    await body(harness, await runLauncher(harness, launcher));
  } finally {
    await harness.cleanup();
  }
}

for (const launcher of LAUNCHERS) {
  Deno.test(
    `${launcher.name} - a blocked container parks the host instead of rebuilding`,
    async () => {
      await withHarness(
        {
          STUB_EGRESS_EXIT: String(EGRESS_BLOCKED_EXIT),
          STUB_EGRESS_EVIDENCE: BLOCKED_EVIDENCE,
        },
        async (harness, outcome) => {
          // A named status, not a bare failure — the supervisor can tell this
          // apart from a crashed worker.
          assertEquals(
            outcome.code,
            HOST_EGRESS_BLOCKED_EXIT_STATUS,
            outcome.stderr,
          );

          // Nothing was rebuilt: the whole point is not to spend minutes on a
          // build that cannot succeed.
          assertEquals(await buildCount(harness), 0);
          assertEquals(await recorded(harness, "run"), null);

          // The attribution the incident got wrong.
          assertEquals(await launchPhaseMarker(harness), "container_egress");
          assertStringIncludes(outcome.stderr, "not the image build");

          // The escalation carries the hop table, the reject route and the
          // tunnel holding a default route.
          const handedOver = await recordedLaunchLog(harness);
          assert(handedOver !== null, "no evidence reached the recorder");
          assertStringIncludes(handedOver, "container → 1.1.1.1:443 | FAIL");
          assertStringIncludes(handedOver, "host → 1.1.1.1:443 | OK");
          assertStringIncludes(handedOver, "bridge100");
          assertStringIncludes(handedOver, "utun8");
          // A blocked host is not a link outage: it must not be suppressed.
          assertEquals(isNetworkUnavailableLaunch(handedOver), false);

          // Per host, in the host's own log: unavailable capacity, named.
          assertStringIncludes(
            await runCoreLog(harness),
            "container_egress_blocked",
          );
        },
        launcher,
      );
    },
  );

  Deno.test(
    `${launcher.name} - a link outage waits instead of calling a human`,
    async () => {
      await withHarness(
        {
          STUB_EGRESS_EXIT: String(NETWORK_DOWN_EXIT),
          STUB_EGRESS_EVIDENCE: NETWORK_DOWN_EVIDENCE,
        },
        async (harness, outcome) => {
          assert(outcome.code !== 0, "a network outage still ends the launch");
          assert(
            outcome.code !== HOST_EGRESS_BLOCKED_EXIT_STATUS,
            "a link outage must not be reported as a parked host",
          );
          assertEquals(await buildCount(harness), 0);

          // Not attributed to this host: the marker keeps the streak off the
          // failure ladder (Issue #949).
          const handedOver = await recordedLaunchLog(harness);
          assert(handedOver !== null, "no evidence reached the recorder");
          assertEquals(isNetworkUnavailableLaunch(handedOver), true);
          assertEquals(await launchPhaseMarker(harness), "runtime_detection");
        },
        launcher,
      );
    },
  );

  Deno.test(
    `${launcher.name} - a reachable container builds and launches as before`,
    async () => {
      await withHarness({}, async (harness, outcome) => {
        assertEquals(outcome.code, 0, outcome.stderr);
        assertEquals(await buildCount(harness), 1);

        // Probed before the build, with the launch plan's own runtime and
        // image, and an evidence file to write to.
        const args = await recorded(harness, "container-egress-probe");
        assert(args !== null, "the launcher never probed egress");
        assert(args.includes("--runtime"));
        assert(args.includes("--image"));
        assert(args.includes("--out"));
        assert(args.includes("--base-dir"));

        const order = await denoInvocationOrder(harness);
        const probe = order.indexOf("container-egress-probe");
        assert(probe >= 0, `probe missing from ${order.join(",")}`);
        assert(
          probe > order.indexOf("container-launch-plan"),
          "the probe needs the plan's runtime and image",
        );
      }, launcher);
    },
  );
}

// ---------------------------------------------------------------------------
// The statuses the launchers branch on must match the command's (Issue #997)
// ---------------------------------------------------------------------------

// The three tests above drive `run.sh` end to end, so its statuses are held by
// behaviour. `run.ps1` cannot be: PowerShell is absent on most of the fleet's
// hosts and on CI, so those tests do not run there. This is the one check that
// keeps the Windows launcher pinned to the same three numbers as the command
// and the bash launcher — a constant, in three languages, that no single
// process can execute.
Deno.test("the launchers hardcode the probe's exit statuses correctly", async () => {
  for (
    const [name, dialect, pattern] of [
      ["run.sh", "bash", /EGRESS_BLOCKED_EXIT=(\d+)/],
      ["run.ps1", "powershell", /\$EgressBlockedExit\s*=\s*(\d+)/],
    ] as const
  ) {
    const source = await Deno.readTextFile(
      new URL(`../../../${name}`, import.meta.url),
    );
    const body = executableLines(source, dialect).join("\n");
    const blocked = pattern.exec(body);
    assert(blocked, `${name} does not name the egress-blocked status`);
    assertEquals(Number(blocked[1]), EGRESS_BLOCKED_EXIT);

    const parked =
      /HOST_EGRESS_BLOCKED_EXIT_STATUS=(\d+)|\$HostEgressBlockedExitStatus\s*=\s*(\d+)/
        .exec(body);
    assert(parked, `${name} does not name the parked exit status`);
    assertEquals(
      Number(parked[1] ?? parked[2]),
      HOST_EGRESS_BLOCKED_EXIT_STATUS,
    );
  }
});
