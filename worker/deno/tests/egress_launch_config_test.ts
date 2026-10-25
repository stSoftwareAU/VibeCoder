/**
 * Tests for the host-side egress inputs read from `.config.json` (Issue #4047).
 *
 * Each test writes a real configuration file to a temporary directory and
 * calls the real reader, so the posture (fail loud on a bad file, absent keys
 * are defaults, the extra hosts returned raw) is pinned against the file the
 * launcher actually reads.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { readConfiguredEgressInputs } from "../lib/egress_launch_config.ts";
import { resolveEgressAllowlist } from "../lib/egress_allowlist.ts";
import { buildContainerLaunchPlan } from "../lib/container_launch.ts";
import {
  CONTAINER_RUNTIMES,
  type ContainerRuntimeDescriptor,
} from "../lib/container_runtime.ts";
import { parseContainerManifest } from "../lib/container_manifest.ts";

const TEST_FILE_PATH = new URL(import.meta.url).pathname;
const REPO_ROOT = TEST_FILE_PATH.replace(/\/worker\/deno\/tests\/[^/]+$/, "");

/** Write `content` as the configuration file of a fresh temporary directory. */
async function withConfig(
  content: string,
  body: (file: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "egress-launch-config-" });
  try {
    const file = `${dir}/.config.json`;
    await Deno.writeTextFile(file, content);
    await body(file);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("readConfiguredEgressInputs - absent keys are the defaults (Issue #4047)", async () => {
  await withConfig("{}", async (file) => {
    const inputs = await readConfiguredEgressInputs(file);
    assertEquals(inputs.imgbbConfigured, false);
    assertEquals(inputs.extraHosts, undefined);
  });
});

Deno.test("readConfiguredEgressInputs - reads a configured ImgBB key and extra hosts (Issue #4047)", async () => {
  await withConfig(
    JSON.stringify({
      imgbb_api_key: "key-value",
      egress_allow_hosts: ["registry.example.com"],
    }),
    async (file) => {
      const inputs = await readConfiguredEgressInputs(file);
      assertEquals(inputs.imgbbConfigured, true);
      assertEquals(inputs.extraHosts, ["registry.example.com"]);
    },
  );
});

Deno.test("readConfiguredEgressInputs - a blank or null ImgBB key counts as unset (Issue #4047)", async () => {
  for (const value of ["", "   ", null]) {
    await withConfig(
      JSON.stringify({ imgbb_api_key: value }),
      async (file) => {
        const inputs = await readConfiguredEgressInputs(file);
        assertEquals(inputs.imgbbConfigured, false, JSON.stringify(value));
      },
    );
  }
});

Deno.test("readConfiguredEgressInputs - an ImgBB key of the wrong shape fails loud (Issue #4047)", async () => {
  await withConfig(
    JSON.stringify({ imgbb_api_key: 42 }),
    async (file) => {
      await assertRejects(
        () => readConfiguredEgressInputs(file),
        Error,
        'key "imgbb_api_key" must be a string',
      );
    },
  );
});

Deno.test("readConfiguredEgressInputs - unparseable JSON fails loud, naming the file (Issue #4047)", async () => {
  await withConfig("{ not json", async (file) => {
    await assertRejects(
      () => readConfiguredEgressInputs(file),
      Error,
      `${file} is not readable JSON`,
    );
  });
});

Deno.test("readConfiguredEgressInputs - a file that is not a JSON object fails loud (Issue #4047)", async () => {
  for (const content of ["[]", "null", '"text"']) {
    await withConfig(content, async (file) => {
      await assertRejects(
        () => readConfiguredEgressInputs(file),
        Error,
        "does not hold a JSON object",
      );
    });
  }
});

Deno.test("readConfiguredEgressInputs - an unreadable file fails loud (Issue #4047)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "egress-launch-config-" });
  try {
    const missing = `${dir}/absent.json`;
    await assertRejects(
      () => readConfiguredEgressInputs(missing),
      Error,
      `${missing} is unreadable`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readConfiguredEgressInputs - a non-array extra hosts value is returned raw, and the resolver names the fault (Issue #4047)", async () => {
  await withConfig(
    JSON.stringify({ egress_allow_hosts: "github.com" }),
    async (file) => {
      const inputs = await readConfiguredEgressInputs(file);
      assertEquals(inputs.extraHosts, "github.com");
      assertThrows(
        () =>
          resolveEgressAllowlist({
            enabledProviderIds: [],
            imgbbConfigured: inputs.imgbbConfigured,
            extraHosts: inputs.extraHosts,
          }),
        Error,
        "egress_allow_hosts must be an array of hostnames",
      );
    },
  );
});

Deno.test("readConfiguredEgressInputs - an invalid extra host is returned raw, and the resolver names the entry (Issue #4047)", async () => {
  await withConfig(
    JSON.stringify({ egress_allow_hosts: ["bad host"] }),
    async (file) => {
      const inputs = await readConfiguredEgressInputs(file);
      assertThrows(
        () =>
          resolveEgressAllowlist({
            enabledProviderIds: [],
            imgbbConfigured: inputs.imgbbConfigured,
            extraHosts: inputs.extraHosts,
          }),
        Error,
        'egress_allow_hosts entry "bad host" is not a valid host',
      );
    },
  );
});

Deno.test("the operator's egress_allow_hosts reach the egress proxy's allowlist (Issue #4047)", async () => {
  await withConfig(
    JSON.stringify({ egress_allow_hosts: ["registry.example.com"] }),
    async (file) => {
      const configured = await readConfiguredEgressInputs(file);
      const allowlist = resolveEgressAllowlist({
        enabledProviderIds: ["claude"],
        imgbbConfigured: configured.imgbbConfigured,
        extraHosts: configured.extraHosts,
      });
      assert(allowlist.includes("registry.example.com"));

      const candidate = CONTAINER_RUNTIMES.docker;
      const descriptor: ContainerRuntimeDescriptor = {
        platform: "linux",
        kind: "docker",
        executable: candidate.executable,
        displayName: candidate.displayName,
        dialect: candidate.dialect,
        probed: ["docker"],
      };
      const manifest = parseContainerManifest(
        await Deno.readTextFile(`${REPO_ROOT}/container/tools.json`),
      );
      const plan = buildContainerLaunchPlan({
        descriptor,
        manifest,
        image: "vibe-coder:0123456789ab",
        containerName: "vibe-coder-4047",
        buildCommit: "0123456789abcdef0123456789abcdef01234567",
        watchdogSeconds: 11_400,
        egressAllowlist: allowlist,
        hostPaths: {
          homeDir: "/home/operator",
          baseDir: "/opt/VibeCoder",
          workDir: "/home/operator/auto-issue-work",
          logDir: "/home/operator/logs",
          configFile: "/opt/VibeCoder/.config.json",
          configStageDir: "/home/operator/.vibe-coder/run-config",
          credentialDir: "/home/operator/.vibe-coder/credentials",
        },
      });
      const egress = plan.egress;
      assert(egress !== undefined);
      const hosts = egress.proxyRunArgs.find((arg) =>
        arg.startsWith("VIBE_EGRESS_ALLOW_HOSTS=")
      ) ?? "";
      assertStringIncludes(hosts, "registry.example.com");
    },
  );
});
