/**
 * run-security-scan fills known-open SEC- ids when the flag is omitted
 * (Issue #3045, PR #3068 review).
 */

import { assert, assertEquals } from "@std/assert";
import { executeRunSecurityScan } from "../commands/run_security_scan.ts";

const FLEET_LOGIN = "vibe-coder-bot";

function findingIdGh(): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const jsonIdx = args.indexOf("--json");
    const jsonField = jsonIdx >= 0 ? args[jsonIdx + 1] : "";
    if (
      jsonField === "number,body,author" && !args.includes("--label") &&
      !args.includes("--search")
    ) {
      return Promise.resolve(JSON.stringify([{
        number: 7,
        body: "<!-- finding-id: SEC-abc123 -->",
        author: { login: FLEET_LOGIN },
      }]));
    }
    return Promise.resolve("[]");
  };
}

Deno.test("run-security-scan - a fleet-authored SEC- id reaches the scanner when the flag is omitted", async () => {
  const seen: string[][] = [];
  const result = await executeRunSecurityScan(
    { repo: "o/r", "work-dir": "/tmp/repo" },
    {
      ghCommandFn: findingIdGh(),
      fleetAuthors: [FLEET_LOGIN],
      runSecurityScanFn: (opts) => {
        seen.push([...opts.knownOpenFindingIds]);
        return Promise.resolve({ ok: true, value: { ok: true } });
      },
    },
  );
  assert(result.success, result.message);
  assertEquals(seen, [["SEC-abc123"]]);
});
