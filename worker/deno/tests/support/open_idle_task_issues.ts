/**
 * Builds the open `idle-task` issues a `findOpenIdleTaskIssuesFn` stub
 * returns, one per title, numbered from 1 (Issue #2752).
 */

import type { ExistingIdleTaskIssue } from "../../lib/idle_task_issue.ts";

export function openIdleTaskIssues(
  titles: readonly string[],
  repo = "org/alpha",
): ExistingIdleTaskIssue[] {
  return titles.map((title, i) => ({
    number: i + 1,
    title,
    url: `https://github.com/${repo}/issues/${i + 1}`,
  }));
}
