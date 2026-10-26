/**
 * Rewrite a rendered launch plan for launcher tests (Issue #4047).
 *
 * The darwin runtime probe only considers Apple container, so a test on this
 * host cannot make `container-launch-plan` emit Docker's egress keys. The
 * deno stub runs this after the real command when one of the STUB_* variables
 * below is set. It does not run in production.
 *
 * The variables are the stub process's own environment, set by the harness
 * for that one launcher, not the test process.
 */

const planPath = Deno.args[0];
if (!planPath || !planPath.trim()) {
  throw new Error("egress_plan_mutator requires a rendered launch-plan path");
}
const raw = await Deno.readFile(planPath);
const text = new TextDecoder().decode(raw);
const parts = text.split("\0").filter((part) => part.length > 0);

const omit = new Set(
  (Deno.env.get("STUB_OMIT_PLAN_KEYS") ?? "").split(",").map((key) =>
    key.trim()
  )
    .filter((key) => key.length > 0),
);

function keyOf(part: string): string {
  const at = part.indexOf("=");
  return at < 0 ? part : part.slice(0, at);
}

let next = parts.filter((part) => !omit.has(keyOf(part)));

if (Deno.env.get("STUB_FORCE_EGRESS_ENFORCED") === "1") {
  next = next.filter((part) => keyOf(part) !== "egress-enforced");
  next.push("egress-enforced=true");
}

if (Deno.env.get("STUB_INJECT_EGRESS_PLAN") === "1") {
  const bundle = Deno.env.get("STUB_EGRESS_BUNDLE");
  if (!bundle || bundle.trim() === "") {
    throw new Error("STUB_EGRESS_BUNDLE is required to inject an egress plan");
  }
  const drop = new Set([
    "egress-enforced",
    "network-create",
    "network-remove",
    "network-connect",
    "proxy-run",
    "proxy-stop",
    "proxy-name",
    "proxy-bundle",
  ]);
  next = next.filter((part) => !drop.has(keyOf(part)));
  const proxyRun = [
    "run",
    "-i",
    "--name",
    "vibe-test-proxy",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--network",
    "bridge",
    "--entrypoint",
    "bash",
    "vibe-coder:test",
    "-c",
    "exec deno run --allow-net worker/deno/egress_proxy_main.ts",
  ];
  const tokens = [
    "egress-enforced=true",
    ...["network", "create", "--internal", "vibe-test-net"].map((arg) =>
      `network-create=${arg}`
    ),
    ...["network", "rm", "vibe-test-net"].map((arg) => `network-remove=${arg}`),
    ...["network", "connect", "vibe-test-net", "vibe-test-proxy"].map((arg) =>
      `network-connect=${arg}`
    ),
    ...proxyRun.map((arg) => `proxy-run=${arg}`),
    ...["rm", "--force", "vibe-test-proxy"].map((arg) => `proxy-stop=${arg}`),
    "proxy-name=vibe-test-proxy",
    `proxy-bundle=${bundle}`,
  ];
  next.push(...tokens);
}

await Deno.writeFile(
  planPath,
  new TextEncoder().encode(`${next.join("\0")}\0`),
);
