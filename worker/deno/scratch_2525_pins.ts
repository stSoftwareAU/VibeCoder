// Scratch: does every annotated SHA pin resolve to the tag it claims?
import { readWorkflowFiles } from "./lib/workflow_scan_common.ts";
import { collectActionPins } from "./lib/workflow_hygiene_check.ts";

const repo = "/home/vibe/auto-issue-work/worktrees/s1/VibeCoder";
const files = await readWorkflowFiles(repo);
const pins = files.flatMap((f) => collectActionPins(f.rawText, f.path));
const seen = new Map<string, string>();
for (const pin of pins) {
  if (pin.version === undefined) {
    console.log(`UNANNOTATED ${pin.file}:${pin.line} ${pin.action}`);
    continue;
  }
  const coordinate = pin.action.split("/").slice(0, 2).join("/");
  const key = `${coordinate}@${pin.version}`;
  let sha = seen.get(key);
  if (sha === undefined) {
    const out = await new Deno.Command("gh", {
      args: ["api", `repos/${coordinate}/commits/${pin.version}`, "--jq", ".sha"],
    }).output();
    sha = out.success ? new TextDecoder().decode(out.stdout).trim() : "UNRESOLVED";
    seen.set(key, sha);
  }
  const ok = sha === pin.sha.toLowerCase();
  console.log(`${ok ? "ok  " : "DRIFT"} ${key} ${pin.file}:${pin.line} pinned=${pin.sha} tag=${sha}`);
}
