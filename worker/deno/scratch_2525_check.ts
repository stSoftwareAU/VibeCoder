// Scratch verification for issue #2525 — deleted before commit.
import { readWorkflowFiles } from "./lib/workflow_scan_common.ts";
import { scanActionAdvisories } from "./lib/action_advisory_scanner.ts";

const repo = "/home/vibe/auto-issue-work/worktrees/s1/VibeCoder";

async function gh(args: string[]): Promise<string> {
  const target = args[1] ?? "";
  if (!target.includes("codeql-action")) return "[]";
  const out = await new Deno.Command("gh", { args }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  const text = new TextDecoder().decode(out.stdout);
  console.log(`  gh ${args.join(" ")} -> ${text.trim().slice(0, 80)}`);
  return text;
}

const files = await readWorkflowFiles(repo);
const findings = await scanActionAdvisories(files, {
  ghCommandFn: gh,
  onLookupFailure: (c, r) => console.log(`  lookup failed ${c}: ${r}`),
});
console.log(`findings: ${findings.length}`);
for (const f of findings) {
  console.log(`  ${f.id} ${f.severity} ${f.title}`);
}
