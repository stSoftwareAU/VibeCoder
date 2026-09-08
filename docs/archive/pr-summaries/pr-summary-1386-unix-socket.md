## Summary

The host-scoped `--allow-net` from Issue #1386 broke every browser tool call.
`@playwright/mcp` binds a browser server on a **unix domain socket** whose name
carries a fresh guid (`makeSocketPath` in `playwright-core` →
`$TMPDIR/pw-<user-hash>/browser/browser@<guid>.sock`), and Deno scopes a unix
socket by its **exact absolute path** only — there is no directory or glob
form. So the allowlist could not name the socket, and the container-build MCP
probe failed with:

```text
FAILED: navigate: NotCapable: object.create: Requires net access to
"unix:/tmp/pw-7505d64a/browser/browser@8cdbe0.sock", run again with the
--allow-net flag
```

`generateMcpConfig` now grants `--allow-net` and takes the cloud metadata
endpoints back off it with `--deny-net=<PLAYWRIGHT_MCP_BLOCKED_HOSTS>` — Deno's
deny list beats its allow list — reusing the list `--blocked-origins` already
uses. Both failure modes still fail loud: an empty deny list throws rather than
dropping the guard, and a host carrying a comma or whitespace throws rather
than emitting a fragmented list that looks complete and denies nothing.

`VIBE_BROWSER_ALLOWED_HOSTS` is removed from the environment registry and
`docs/DEPLOYMENT.md`: with no allow list left to extend, the knob would have
been a silent no-op.

**Residual risk, stated plainly:** this is weaker than the allowlist it
replaces — the MCP server process can reach any host not named in the deny
list. What remains is the container's egress boundary, `--blocked-origins` on
what the browser may request, and the denied credential paths and environment
variables that leave a compromised server nothing worth exfiltrating. Scoping
the allow side is not expressible in Deno while the server binds a
randomly-named unix socket.

## Evidence

Backend change with no web surface to screenshot: the deliverable is the argv
`generateMcpConfig` produces and the MCP server actually starting.

Generated flags, before and after:

```text
- --allow-net=127.0.0.1,localhost,[::1]
+ --allow-net
+ --deny-net=169.254.169.254,169.254.170.2,[fd00:ec2::254],metadata.google.internal,metadata.goog,100.100.100.100
```

Live MCP probe against the generated config (the same handshake the
container-build workflow runs), before → after:

```text
before: NAV: {"content":[{"type":"text","text":"### Error\nNotCapable: object.create:
        Requires net access to \"unix:/tmp/pw-7505d64a/browser/browser@10b39e.sock\""}],"isError":true}
after:  NAV: {"result":{"content":[{"type":"text","text":"### Ran Playwright code\n
        await page.goto('about:blank');"}]}}  exit=0
```

The deny side still bites:

```text
$ deno run --allow-net --deny-net=169.254.169.254 denycheck.ts
BLOCKED: NotCapable Requires net access to "169.254.169.254:80"
```

```text
$ deno test --allow-all tests/setup_screenshot_test.ts …
ok | 95 passed | 0 failed
```
