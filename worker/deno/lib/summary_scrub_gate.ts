/** Refuse prompt-scrubbed HTML markers in published PR summaries (Issue #3710). */
export function summaryScrubProblem(summary: string): string | undefined {
  if (summary.includes("--․>") || summary.includes("<․!--")) {
    return "The PR summary contains prompt-scrubbed HTML comment or Mermaid " +
      "markers (U+2024). Read the original file and restore its literal " +
      "Markdown; never copy the scrubbed gate notice back into the summary.";
  }
  return undefined;
}
