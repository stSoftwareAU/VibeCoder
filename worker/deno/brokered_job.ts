/** Fixed entrypoint inside a credential-free, network-none job container. */
import { prepareBrokeredJobEnvironment } from "./lib/brokered_job_environment.ts";

let exitCode = 1;
let profile:
  | Awaited<ReturnType<typeof prepareBrokeredJobEnvironment>>
  | undefined;
try {
  if (Deno.args[0] !== "--" || !Deno.args[1] || Deno.args[1].startsWith("-")) {
    throw new Error("Isolated job requires a container command");
  }
  const metadataFile = await Deno.open("/run/broker/session.json", {
    read: true,
  });
  let metadata: string;
  try {
    const bytes = new Uint8Array(4097);
    let size = 0;
    while (size < bytes.length) {
      const count = await metadataFile.read(bytes.subarray(size));
      if (count === null) break;
      size += count;
    }
    if (size > 4096) throw new Error("Broker public metadata exceeds limit");
    metadata = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, size),
    );
  } finally {
    metadataFile.close();
  }
  profile = await prepareBrokeredJobEnvironment(JSON.parse(metadata));
  const child = new Deno.Command(Deno.args[1], {
    args: Deno.args.slice(2),
    clearEnv: true,
    env: profile.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const stop = () => {
    try {
      child.kill("SIGTERM");
    } catch { /* Host reaps the entire container. */ }
  };
  Deno.addSignalListener("SIGTERM", stop);
  Deno.addSignalListener("SIGINT", stop);
  try {
    exitCode = (await child.status).code;
  } finally {
    Deno.removeSignalListener("SIGTERM", stop);
    Deno.removeSignalListener("SIGINT", stop);
  }
} catch {
  console.error("Isolated job could not start or complete");
} finally {
  try {
    await profile?.close();
  } catch {
    console.error("Isolated job cleanup failed");
    exitCode = 1;
  }
}
Deno.exit(exitCode);
