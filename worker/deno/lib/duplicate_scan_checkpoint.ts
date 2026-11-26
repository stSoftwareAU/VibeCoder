// Durable progress belongs to the wrapper so another fleet host can resume it.
import { isFleetAuthor } from "./fleet_authors.ts";
import { getHostname } from "./worker_identity.ts";
import { idleTaskWrapperCommentArgs } from "./idle_task_wrapper_closure.ts";
import { DISCOVERY_LABELS, LABEL_DEFAULTS } from "./config_defaults.ts";

export const DUPLICATED_KNOWLEDGE_ISSUE_TITLE =
  "Run a duplicated-knowledge scan";
const prefix = "<!-- duplicate-scan-v1 -->";
type Gh = (args: string[]) => Promise<string>;
interface Entry {
  stage: string;
  status: "started" | "finished" | "paused";
  kept: number[];
  assignment?: number;
}

export async function openDuplicateScanJournal(
  repo: string,
  issue: number,
  authors: string[],
  gh: Gh,
) {
  if (!authors.length) throw new Error("Cannot verify scan checkpoint authors");
  const raw = await gh([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repo}/issues/${issue}/comments?per_page=100`,
    "--jq",
    'flatten | map(select(.body | startswith("<!-- duplicate-scan-v1 -->")) | {author:.user.login,body})',
  ]);
  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const row of JSON.parse(raw)) {
    if (
      isFleetAuthor(row.author, authors) && row.body.startsWith(prefix + "\n")
    ) {
      const record = JSON.parse(row.body.split("\n")[1]);
      if (typeof record.id !== "string" || seen.has(record.id)) continue;
      seen.add(record.id);
      entries.push(record);
    }
  }
  async function save(entry: Entry, detail: string) {
    await gh(
      idleTaskWrapperCommentArgs(
        repo,
        issue,
        `${prefix}\n${
          JSON.stringify({ ...entry, id: crypto.randomUUID() })
        }\n\n${detail} · ${getHostname()}`,
      ),
    );
    entries.push(entry);
  }
  async function pause(stage: string, detail: string) {
    const view = JSON.parse(
      await gh([
        "issue",
        "view",
        String(issue),
        "--repo",
        repo,
        "--json",
        "labels",
      ]),
    );
    const triggers = [...DISCOVERY_LABELS, "idle-task"];
    const labels = (view.labels as { name: string }[]).map((l) => l.name)
      .filter((l) => triggers.includes(l));
    const args = [
      "issue",
      "edit",
      String(issue),
      "--repo",
      repo,
      "--add-label",
      LABEL_DEFAULTS.needsHumanLabel,
    ];
    for (const label of labels) args.push("--remove-label", label);
    await gh(args);
    await save(
      { stage, status: "paused", kept: [] },
      detail + " To resume, clear needs-human and restore a work priority.",
    );
  }
  return {
    async recover(assignment: number) {
      const stage = "claim recovery";
      const previous = entries.at(-1);
      if (previous?.stage === stage && previous.status === "started") {
        // Multiple recovery hosts can observe the same GitHub assignment.
        if (previous.assignment === assignment) return;
        await pause(
          stage,
          "Two distinct claims were recovered without an intervening scan checkpoint. Inspect worker startup and heartbeat logs.",
        );
        return;
      }
      await save(
        { stage, status: "started", kept: [], assignment },
        `Recovered claim. Last recorded scan stage: ${
          previous?.stage ?? "none"
        }.`,
      );
    },
    completed(stage: string) {
      return entries.findLast((e) =>
        e.stage === stage && e.status === "finished"
      );
    },
    async begin(stage: string) {
      const history = entries.filter((e) => e.stage === stage);
      const reset = history.findLastIndex((e) => e.status !== "started");
      if (history.length - reset - 1 >= 2) {
        const advice = stage.includes("/review") || stage.endsWith("/filing")
          ? "Split the remaining review into smaller tasks."
          : "Inspect the worker logs for this stage before retrying.";
        const detail =
          `Paused at ${stage} after two attempts without a completed checkpoint. ${advice}`;
        await pause(stage, detail);
        throw new Error(detail);
      }
      await save(
        { stage, status: "started", kept: [] },
        `Starting ${stage} (attempt ${history.length - reset}).`,
      );
    },
    async finish(stage: string, kept: number[] = []) {
      await save({ stage, status: "finished", kept }, `Completed ${stage}.`);
    },
  };
}

export type DuplicateScanJournal = Awaited<
  ReturnType<typeof openDuplicateScanJournal>
>;
