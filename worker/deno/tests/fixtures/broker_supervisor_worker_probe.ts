/** Synthetic worker for the actual supervisor; never contacts an upstream. */
import { countSyntheticCredentialMatches } from "../support/agent_container_evidence.ts";
const [output, release] = Deno.args;
if (!output || !release) throw new Error("Missing fixture artifact paths");
const metadata = JSON.parse(
  await Deno.readTextFile("/run/broker/session.json"),
);
const client = Deno.createHttpClient({
  proxy: { transport: "unix", path: "/run/broker/broker.sock" },
});
let denied = false;
try {
  const response = await fetch(
    "http://broker.invalid/__runtime_probe_denied__",
    {
      client,
      headers: { authorization: `Bearer ${metadata.capability}` },
      signal: AbortSignal.timeout(2000),
    },
  );
  denied = response.status === 403 &&
    await response.text() === "Broker route denied\n";
} finally {
  client.close();
}
let privateReadable = false;
try {
  await Deno.readTextFile("/run/broker-config/session.json");
  privateReadable = true;
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}
let socketWritable = true;
try {
  await Deno.writeTextFile("/run/broker/worker-must-not-write", "probe");
} catch {
  socketWritable = false;
}
const status = await Deno.readTextFile("/proc/self/status");
const mounts = await Deno.readTextFile("/proc/self/mountinfo");
const secretHash = Deno.env.get("VIBE_PROBE_SECRET_HASH");
if (!secretHash || !/^[a-f0-9]{64}$/.test(secretHash)) {
  throw new Error("Missing synthetic credential hash witness");
}
const secretMatches = await countSyntheticCredentialMatches(
  JSON.stringify(Deno.env.toObject()),
  secretHash,
);
const evidence = {
  denied,
  privateReadable,
  socketWritable,
  secretMatches,
  privateMounted: mounts.includes(" /run/broker-config "),
  capEff: status.match(/^CapEff:\s*(\S+)/m)?.[1],
  noNewPrivileges: status.match(/^NoNewPrivs:\s*(\S+)/m)?.[1],
  seccomp: status.match(/^Seccomp:\s*(\S+)/m)?.[1],
};
// This artifact contains booleans and kernel flags only, never session data.
await Deno.writeTextFile(output, JSON.stringify(evidence), {
  mode: 0o644,
  createNew: true,
});
while (true) {
  try {
    await Deno.stat(release);
    break;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
}
