/**
 * Built-in GitHub Actions CI log provider (Issues #3580, #3579).
 *
 * Wraps the Actions log fetcher as a {@link CiLogProvider} so the
 * default provider and every external one share a single dispatch path.
 * This is also the fall-back the registry returns when no external
 * provider matches, so every repo gets real job logs with zero
 * configuration.
 *
 * Uses Australian English throughout (behaviour, organisation, colour).
 */ import { fetchGithubActionsLogExcerpt, GITHUB_ACTIONS_PROVIDER_ID, parseActionsCheckUrl } from "./github_actions_log_fetcher.ts";
import { assertNever } from "./assert_never.ts";
export { GITHUB_ACTIONS_PROVIDER_ID };
/** The built-in GitHub Actions provider. */ export const githubActionsCiLogProvider = {
  id: GITHUB_ACTIONS_PROVIDER_ID,
  matches (ctx) {
    const config = ctx.providerConfig;
    if (config && config.provider !== GITHUB_ACTIONS_PROVIDER_ID) return false;
    if (parseActionsCheckUrl(ctx.targetUrl ?? "").kind !== "other") return true;
    // No usable URL: a check run id still lets the fetcher resolve the job.
    return (ctx.checkRunId ?? "") !== "";
  },
  async fetchLog (ctx) {
    if (!ctx.ghFn) {
      return {
        ok: false,
        error: "github-actions provider requires a gh command runner"
      };
    }
    // Never echo `ctx.targetUrl` back as the excerpt URL — see the
    // `fetchLog` contract. The run id is parsed out of it and the URL is
    // rebuilt against github.com for this repo, so a hostile `targetUrl`
    // cannot reach the prompt.
    const parsed = parseActionsCheckUrl(ctx.targetUrl ?? "");
    const runUrl = parsed.kind === "other" ? `https://github.com/${ctx.repo}/actions/runs` : `https://github.com/${ctx.repo}/actions/runs/${parsed.runId}`;
    const fetchExcerpt = ctx.actionsLogFn ?? fetchGithubActionsLogExcerpt;
    const outcome = await fetchExcerpt({
      repo: ctx.repo,
      checkRunId: ctx.checkRunId ?? "",
      checkName: ctx.checkName,
      ...ctx.targetUrl !== undefined ? {
        targetUrl: ctx.targetUrl
      } : {},
      ghFn: ctx.ghFn
    });
    switch(outcome.kind){
      case "excerpt":
        return {
          ok: true,
          value: {
            providerId: GITHUB_ACTIONS_PROVIDER_ID,
            buildId: String(outcome.jobId),
            url: runUrl,
            logText: outcome.excerpt
          }
        };
      case "not-applicable":
        return {
          ok: false,
          error: outcome.reason
        };
      case "error":
        return {
          ok: false,
          error: outcome.error
        };
      default:
        // Exhaustiveness guard — a new outcome kind must be handled above.
        return assertNever(outcome);
    }
  }
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jaV9wcm92aWRlcl9naXRodWJfYWN0aW9ucy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEJ1aWx0LWluIEdpdEh1YiBBY3Rpb25zIENJIGxvZyBwcm92aWRlciAoSXNzdWVzICMzNTgwLCAjMzU3OSkuXG4gKlxuICogV3JhcHMgdGhlIEFjdGlvbnMgbG9nIGZldGNoZXIgYXMgYSB7QGxpbmsgQ2lMb2dQcm92aWRlcn0gc28gdGhlXG4gKiBkZWZhdWx0IHByb3ZpZGVyIGFuZCBldmVyeSBleHRlcm5hbCBvbmUgc2hhcmUgYSBzaW5nbGUgZGlzcGF0Y2ggcGF0aC5cbiAqIFRoaXMgaXMgYWxzbyB0aGUgZmFsbC1iYWNrIHRoZSByZWdpc3RyeSByZXR1cm5zIHdoZW4gbm8gZXh0ZXJuYWxcbiAqIHByb3ZpZGVyIG1hdGNoZXMsIHNvIGV2ZXJ5IHJlcG8gZ2V0cyByZWFsIGpvYiBsb2dzIHdpdGggemVyb1xuICogY29uZmlndXJhdGlvbi5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIG9yZ2FuaXNhdGlvbiwgY29sb3VyKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHR5cGUge1xuICBDaUZhaWx1cmVDb250ZXh0LFxuICBDaUxvZ0V4Y2VycHQsXG4gIENpTG9nUHJvdmlkZXIsXG59IGZyb20gXCIuL2NpX2xvZ19wcm92aWRlci50c1wiO1xuaW1wb3J0IHtcbiAgZmV0Y2hHaXRodWJBY3Rpb25zTG9nRXhjZXJwdCxcbiAgR0lUSFVCX0FDVElPTlNfUFJPVklERVJfSUQsXG4gIHBhcnNlQWN0aW9uc0NoZWNrVXJsLFxufSBmcm9tIFwiLi9naXRodWJfYWN0aW9uc19sb2dfZmV0Y2hlci50c1wiO1xuaW1wb3J0IHsgYXNzZXJ0TmV2ZXIgfSBmcm9tIFwiLi9hc3NlcnRfbmV2ZXIudHNcIjtcblxuZXhwb3J0IHsgR0lUSFVCX0FDVElPTlNfUFJPVklERVJfSUQgfTtcblxuLyoqIFRoZSBidWlsdC1pbiBHaXRIdWIgQWN0aW9ucyBwcm92aWRlci4gKi9cbmV4cG9ydCBjb25zdCBnaXRodWJBY3Rpb25zQ2lMb2dQcm92aWRlcjogQ2lMb2dQcm92aWRlciA9IHtcbiAgaWQ6IEdJVEhVQl9BQ1RJT05TX1BST1ZJREVSX0lELFxuXG4gIG1hdGNoZXMoY3R4OiBDaUZhaWx1cmVDb250ZXh0KTogYm9vbGVhbiB7XG4gICAgY29uc3QgY29uZmlnID0gY3R4LnByb3ZpZGVyQ29uZmlnO1xuICAgIGlmIChjb25maWcgJiYgY29uZmlnLnByb3ZpZGVyICE9PSBHSVRIVUJfQUNUSU9OU19QUk9WSURFUl9JRCkgcmV0dXJuIGZhbHNlO1xuICAgIGlmIChwYXJzZUFjdGlvbnNDaGVja1VybChjdHgudGFyZ2V0VXJsID8/IFwiXCIpLmtpbmQgIT09IFwib3RoZXJcIikgcmV0dXJuIHRydWU7XG4gICAgLy8gTm8gdXNhYmxlIFVSTDogYSBjaGVjayBydW4gaWQgc3RpbGwgbGV0cyB0aGUgZmV0Y2hlciByZXNvbHZlIHRoZSBqb2IuXG4gICAgcmV0dXJuIChjdHguY2hlY2tSdW5JZCA/PyBcIlwiKSAhPT0gXCJcIjtcbiAgfSxcblxuICBhc3luYyBmZXRjaExvZyhcbiAgICBjdHg6IENpRmFpbHVyZUNvbnRleHQsXG4gICk6IFByb21pc2U8UmVzdWx0PENpTG9nRXhjZXJwdCwgc3RyaW5nPj4ge1xuICAgIGlmICghY3R4LmdoRm4pIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IFwiZ2l0aHViLWFjdGlvbnMgcHJvdmlkZXIgcmVxdWlyZXMgYSBnaCBjb21tYW5kIHJ1bm5lclwiLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBOZXZlciBlY2hvIGBjdHgudGFyZ2V0VXJsYCBiYWNrIGFzIHRoZSBleGNlcnB0IFVSTCDigJQgc2VlIHRoZVxuICAgIC8vIGBmZXRjaExvZ2AgY29udHJhY3QuIFRoZSBydW4gaWQgaXMgcGFyc2VkIG91dCBvZiBpdCBhbmQgdGhlIFVSTCBpc1xuICAgIC8vIHJlYnVpbHQgYWdhaW5zdCBnaXRodWIuY29tIGZvciB0aGlzIHJlcG8sIHNvIGEgaG9zdGlsZSBgdGFyZ2V0VXJsYFxuICAgIC8vIGNhbm5vdCByZWFjaCB0aGUgcHJvbXB0LlxuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlQWN0aW9uc0NoZWNrVXJsKGN0eC50YXJnZXRVcmwgPz8gXCJcIik7XG4gICAgY29uc3QgcnVuVXJsID0gcGFyc2VkLmtpbmQgPT09IFwib3RoZXJcIlxuICAgICAgPyBgaHR0cHM6Ly9naXRodWIuY29tLyR7Y3R4LnJlcG99L2FjdGlvbnMvcnVuc2BcbiAgICAgIDogYGh0dHBzOi8vZ2l0aHViLmNvbS8ke2N0eC5yZXBvfS9hY3Rpb25zL3J1bnMvJHtwYXJzZWQucnVuSWR9YDtcblxuICAgIGNvbnN0IGZldGNoRXhjZXJwdCA9IGN0eC5hY3Rpb25zTG9nRm4gPz8gZmV0Y2hHaXRodWJBY3Rpb25zTG9nRXhjZXJwdDtcbiAgICBjb25zdCBvdXRjb21lID0gYXdhaXQgZmV0Y2hFeGNlcnB0KHtcbiAgICAgIHJlcG86IGN0eC5yZXBvLFxuICAgICAgY2hlY2tSdW5JZDogY3R4LmNoZWNrUnVuSWQgPz8gXCJcIixcbiAgICAgIGNoZWNrTmFtZTogY3R4LmNoZWNrTmFtZSxcbiAgICAgIC4uLihjdHgudGFyZ2V0VXJsICE9PSB1bmRlZmluZWQgPyB7IHRhcmdldFVybDogY3R4LnRhcmdldFVybCB9IDoge30pLFxuICAgICAgZ2hGbjogY3R4LmdoRm4sXG4gICAgfSk7XG5cbiAgICBzd2l0Y2ggKG91dGNvbWUua2luZCkge1xuICAgICAgY2FzZSBcImV4Y2VycHRcIjpcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICB2YWx1ZToge1xuICAgICAgICAgICAgcHJvdmlkZXJJZDogR0lUSFVCX0FDVElPTlNfUFJPVklERVJfSUQsXG4gICAgICAgICAgICBidWlsZElkOiBTdHJpbmcob3V0Y29tZS5qb2JJZCksXG4gICAgICAgICAgICB1cmw6IHJ1blVybCxcbiAgICAgICAgICAgIGxvZ1RleHQ6IG91dGNvbWUuZXhjZXJwdCxcbiAgICAgICAgICB9LFxuICAgICAgICB9O1xuICAgICAgY2FzZSBcIm5vdC1hcHBsaWNhYmxlXCI6XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IG91dGNvbWUucmVhc29uIH07XG4gICAgICBjYXNlIFwiZXJyb3JcIjpcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogb3V0Y29tZS5lcnJvciB9O1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgLy8gRXhoYXVzdGl2ZW5lc3MgZ3VhcmQg4oCUIGEgbmV3IG91dGNvbWUga2luZCBtdXN0IGJlIGhhbmRsZWQgYWJvdmUuXG4gICAgICAgIHJldHVybiBhc3NlcnROZXZlcihvdXRjb21lKTtcbiAgICB9XG4gIH0sXG59O1xuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7O0NBVUMsR0FRRCxTQUNFLDRCQUE0QixFQUM1QiwwQkFBMEIsRUFDMUIsb0JBQW9CLFFBQ2Ysa0NBQWtDO0FBQ3pDLFNBQVMsV0FBVyxRQUFRLG9CQUFvQjtBQUVoRCxTQUFTLDBCQUEwQixHQUFHO0FBRXRDLDBDQUEwQyxHQUMxQyxPQUFPLE1BQU0sNkJBQTRDO0VBQ3ZELElBQUk7RUFFSixTQUFRLEdBQXFCO0lBQzNCLE1BQU0sU0FBUyxJQUFJLGNBQWM7SUFDakMsSUFBSSxVQUFVLE9BQU8sUUFBUSxLQUFLLDRCQUE0QixPQUFPO0lBQ3JFLElBQUkscUJBQXFCLElBQUksU0FBUyxJQUFJLElBQUksSUFBSSxLQUFLLFNBQVMsT0FBTztJQUN2RSx3RUFBd0U7SUFDeEUsT0FBTyxDQUFDLElBQUksVUFBVSxJQUFJLEVBQUUsTUFBTTtFQUNwQztFQUVBLE1BQU0sVUFDSixHQUFxQjtJQUVyQixJQUFJLENBQUMsSUFBSSxJQUFJLEVBQUU7TUFDYixPQUFPO1FBQ0wsSUFBSTtRQUNKLE9BQU87TUFDVDtJQUNGO0lBRUEsK0RBQStEO0lBQy9ELHFFQUFxRTtJQUNyRSxxRUFBcUU7SUFDckUsMkJBQTJCO0lBQzNCLE1BQU0sU0FBUyxxQkFBcUIsSUFBSSxTQUFTLElBQUk7SUFDckQsTUFBTSxTQUFTLE9BQU8sSUFBSSxLQUFLLFVBQzNCLENBQUMsbUJBQW1CLEVBQUUsSUFBSSxJQUFJLENBQUMsYUFBYSxDQUFDLEdBQzdDLENBQUMsbUJBQW1CLEVBQUUsSUFBSSxJQUFJLENBQUMsY0FBYyxFQUFFLE9BQU8sS0FBSyxFQUFFO0lBRWpFLE1BQU0sZUFBZSxJQUFJLFlBQVksSUFBSTtJQUN6QyxNQUFNLFVBQVUsTUFBTSxhQUFhO01BQ2pDLE1BQU0sSUFBSSxJQUFJO01BQ2QsWUFBWSxJQUFJLFVBQVUsSUFBSTtNQUM5QixXQUFXLElBQUksU0FBUztNQUN4QixHQUFJLElBQUksU0FBUyxLQUFLLFlBQVk7UUFBRSxXQUFXLElBQUksU0FBUztNQUFDLElBQUksQ0FBQyxDQUFDO01BQ25FLE1BQU0sSUFBSSxJQUFJO0lBQ2hCO0lBRUEsT0FBUSxRQUFRLElBQUk7TUFDbEIsS0FBSztRQUNILE9BQU87VUFDTCxJQUFJO1VBQ0osT0FBTztZQUNMLFlBQVk7WUFDWixTQUFTLE9BQU8sUUFBUSxLQUFLO1lBQzdCLEtBQUs7WUFDTCxTQUFTLFFBQVEsT0FBTztVQUMxQjtRQUNGO01BQ0YsS0FBSztRQUNILE9BQU87VUFBRSxJQUFJO1VBQU8sT0FBTyxRQUFRLE1BQU07UUFBQztNQUM1QyxLQUFLO1FBQ0gsT0FBTztVQUFFLElBQUk7VUFBTyxPQUFPLFFBQVEsS0FBSztRQUFDO01BQzNDO1FBQ0UsbUVBQW1FO1FBQ25FLE9BQU8sWUFBWTtJQUN2QjtFQUNGO0FBQ0YsRUFBRSJ9
// denoCacheMetadata=167009402596293512,1348024350597082559