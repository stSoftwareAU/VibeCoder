/** Independent updater process connected to the test's stateful GitHub service. */
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { updateBranch } from "../../../../.claude/skills/review-fleet-prs/scripts/branch_update.ts";
import { fix } from "../../commands/fleet_pr_babysitter.ts";
import { AUTHOR, BASE, REPO } from "./base_refresh_fleet.ts";

const PREFIX = "REFRESH_GITHUB ";
const encoder = new TextEncoder();
const noSleep = async () => {};

/** Spawn a host with no worker configuration, token or credential environment. */
export async function runRefreshHost(
  lane: "reviewer" | "babysitter",
  hostDir: string,
  number: number,
  gh: (args: string[]) => Promise<string>,
): Promise<void> {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--cached-only",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--allow-sys=hostname",
      "--config",
      new URL("../../deno.json", import.meta.url).pathname,
      new URL(import.meta.url).pathname,
      lane,
      hostDir,
      String(number),
    ],
    cwd: hostDir,
    clearEnv: true,
    // These paths select the already populated module cache, not live service
    // configuration. Every product environment variable is absent.
    env: Object.fromEntries(
      ["HOME", "DENO_DIR"].flatMap((key) => {
        const value = Deno.env.get(key);
        return value === undefined ? [] : [[key, value]];
      }),
    ),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  const stderr = new Response(child.stderr).text();
  const timeout = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* The owned child already exited. */ }
  }, 10_000);
  try {
    const lines = createInterface({ input: Readable.fromWeb(child.stdout) });
    for await (const line of lines) {
      if (!line.startsWith(PREFIX)) continue;
      let reply: { value: string } | { error: string };
      try {
        reply = { value: await gh(JSON.parse(line.slice(PREFIX.length))) };
      } catch (error) {
        reply = {
          error: error instanceof Error ? error.message : String(error),
        };
      }
      await writer.write(encoder.encode(`${JSON.stringify(reply)}\n`));
    }
    const status = await child.status;
    const diagnostic = await stderr;
    if (!status.success) {
      throw new Error(`${lane} host failed (${status.code}): ${diagnostic}`);
    }
  } finally {
    clearTimeout(timeout);
    try {
      await writer.close();
    } catch { /* The owned child may have exited. */ }
    writer.releaseLock();
  }
}

if (import.meta.main) {
  const [lane, hostDir, numberText] = Deno.args;
  const number = Number(numberText);
  const inputStream = Readable.fromWeb(Deno.stdin.readable);
  const input = createInterface({ input: inputStream });
  const replies = input[Symbol.asyncIterator]();
  const gh = async (args: string[]): Promise<string> => {
    console.log(`${PREFIX}${JSON.stringify(args)}`);
    const line = await replies.next();
    if (line.done) throw new Error("GitHub service disconnected");
    const reply = JSON.parse(line.value);
    if (reply.error) throw new Error(reply.error);
    return reply.value;
  };
  try {
    const initial = JSON.parse(
      await gh(["pr", "view", String(number), "--json", "statusCheckRollup"]),
    );
    if (lane === "reviewer") {
      await updateBranch(
        { repo: REPO, number, headSha: initial.headRefOid, baseRefName: BASE },
        gh,
        { fleetAuthors: [AUTHOR] },
        undefined,
        { auditDir: hostDir!, runId: `reviewer-${number}` },
        noSleep,
      );
    } else if (lane === "babysitter") {
      await fix(
        REPO,
        initial,
        [AUTHOR],
        AUTHOR,
        { appId: "1", installationId: "1", privateKeyPath: "/unused" },
        "/unused",
        gh,
        noSleep,
        3,
        { stateDir: hostDir },
      );
    } else throw new Error(`Unknown updater lane ${lane}`);
  } finally {
    input.close();
    inputStream.destroy();
  }
}
