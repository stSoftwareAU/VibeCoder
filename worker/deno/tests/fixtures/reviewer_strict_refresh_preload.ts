/** Offline gh boundary; leave the reviewer's actual Deno permissions intact. */
import { strictRefreshFixture } from "../support/strict_refresh_fixture.ts";

const root = Deno.env.get("HOME")!;
const fixture = strictRefreshFixture("acme/app");
const encoder = new TextEncoder();
// GitHub is in memory, so its consistency wait needs no wall-clock delay.
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = Object.assign(
  (...args: Parameters<typeof setTimeout>) => {
    if (args[1] === 3000) args[1] = 0;
    return nativeSetTimeout(...args);
  },
  nativeSetTimeout,
);
Deno.Command = class {
  constructor(private command: string, private options: Deno.CommandOptions) {}
  async output(): Promise<Deno.CommandOutput> {
    const args = this.options.args?.map(String) ?? [];
    if (this.command !== "gh") {
      throw new Error(`Unexpected command ${this.command}`);
    }
    await Deno.writeTextFile(
      `${root}/calls.jsonl`,
      JSON.stringify(args) + "\n",
      { append: true },
    );
    let output: string;
    if (args[1] === "graphql") {
      output = JSON.stringify({
        data: {
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{
              number: 20,
              title: "Ready change",
              url: "https://github.com/acme/app/pull/20",
              isDraft: false,
              mergeable: "MERGEABLE",
              mergeStateStatus: "BEHIND",
              autoMergeRequest: {},
              headRefOid: fixture.head,
              baseRefName: "main",
              repository: {
                nameWithOwner: "acme/app",
                defaultBranchRef: { name: "main" },
              },
              author: { login: "VibeCoderST" },
              commits: {
                nodes: [{
                  commit: {
                    statusCheckRollup: { state: "SUCCESS" },
                    checkSuites: { nodes: [] },
                  },
                }],
              },
              reviews: {
                nodes: [{
                  author: { login: "reviewer" },
                  state: "APPROVED",
                  body: "",
                  commit: { oid: fixture.head },
                }],
              },
            }],
          },
        },
      });
    } else if (args[1]?.endsWith("/comments")) output = "[]";
    else if (args[0] === "pr" && args[1] === "review") output = "";
    else output = await fixture.gh(args);
    return {
      code: 0,
      success: true,
      signal: null,
      stdout: encoder.encode(output),
      stderr: new Uint8Array(),
    };
  }
} as unknown as typeof Deno.Command;
