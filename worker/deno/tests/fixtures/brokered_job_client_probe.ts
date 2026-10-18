/** Runs under the actual isolated entrypoint; creates no adapters of its own. */
import { countSyntheticCredentialMatches } from "../support/agent_container_evidence.ts";

const secretHash = Deno.args[0]!;
const env = Deno.env.toObject();
const fail = (message: string): never => {
  throw new Error(message);
};
if (
  !env.HOME?.startsWith("/tmp/vibe-isolated-job-") || !env.GH_TOKEN ||
  !env.GIT_CONFIG_GLOBAL || env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY ||
  env.CONFIG_PATH
) {
  fail("Isolated entrypoint supplied an invalid repository profile");
}
const gitConfig = await Deno.readTextFile(env.GIT_CONFIG_GLOBAL!);
if (
  await countSyntheticCredentialMatches(
    JSON.stringify(env) + gitConfig,
    secretHash,
  ) !== 0
) {
  fail("Isolated entrypoint exposed an upstream credential");
}
if (gitConfig.includes(env.GH_TOKEN!)) {
  fail("Git configuration contains local capability");
}
const gh = await new Deno.Command("gh", {
  args: ["api", "user", "--jq", ".login"],
  stdin: "null",
  stdout: "piped",
  stderr: "piped",
}).output();
if (
  !gh.success || new TextDecoder().decode(gh.stdout).trim() !== "fixture-user"
) {
  fail("Isolated entrypoint native gh request failed");
}
const git = await new Deno.Command("git", {
  args: [
    "ls-remote",
    "https://github.com/fixture/allowed.git",
    "refs/heads/main",
  ],
  stdin: "null",
  stdout: "piped",
  stderr: "piped",
}).output();
if (
  !git.success ||
  !/^[0-9a-f]{40}\s+refs\/heads\/main\s*$/.test(
    new TextDecoder().decode(git.stdout),
  )
) {
  fail("Isolated entrypoint native Git request failed");
}
if (
  await countSyntheticCredentialMatches(
    new TextDecoder().decode(gh.stdout) + new TextDecoder().decode(git.stdout),
    secretHash,
  ) !== 0
) {
  fail("Isolated entrypoint native response exposed a credential");
}
console.log(
  JSON.stringify({
    nativeEntrypointCompleted: true,
    githubReadCompleted: true,
    gitReadCompleted: true,
    upstreamCredentialVisible: false,
  }),
);
