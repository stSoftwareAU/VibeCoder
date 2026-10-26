/** Trusted parent: generated children return protocol data, never test verdicts. */
const language = Deno.env.get("CAPSEC_LANGUAGE");
if (language !== "typescript" && language !== "rust") {
  throw new Error("CAPSEC_LANGUAGE must identify a supported fixture language");
}

async function call(
  actor: string,
  name: string,
  role: string,
): Promise<string> {
  const cases = [actor, "a", "old", "user", name, role];
  const executable = language === "typescript"
    ? Deno.execPath()
    : "/tmp/build/adapter";
  const args = language === "typescript"
    ? [
      "run",
      "--no-config",
      "--no-lock",
      "--no-remote",
      "--deny-net",
      "--allow-read=/fixture/impl.ts",
      "/fixture/adapter.ts",
      ...cases,
    ]
    : cases;
  const child = new Deno.Command(executable, {
    args,
    clearEnv: true,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", DENO_DIR: "/tmp/deno" },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const output = await child.output();
  if (!output.success) throw new Error(`implementation exited ${output.code}`);
  // A single bounded ASCII response is the whole child protocol. Additional
  // output (including forged test status) never reaches the test reporter.
  if (output.stdout.length > 512) {
    throw new Error("implementation response too large");
  }
  const response = new TextDecoder().decode(output.stdout);
  if (!/^(?:OK\t[ -~]+\t[ -~]+\t[ -~]+|ERR\t[ -~]+)\n$/.test(response)) {
    throw new Error("implementation response is malformed");
  }
  return response.slice(0, -1);
}

Deno.test("functional: authorised update persists", async () => {
  const response = await call("a", "new", "-");
  if (response !== "OK\ta\tnew\tuser") {
    throw new Error(
      "authorised update must retain tenant and role and change name",
    );
  }
});
Deno.test("security: cross-tenant rejected", async () => {
  if (!(await call("b", "stolen", "-")).startsWith("ERR\t")) {
    throw new Error("cross-tenant update must fail");
  }
});
Deno.test("security: privileged field rejected", async () => {
  if (!(await call("a", "-", "admin")).startsWith("ERR\t")) {
    throw new Error("a privileged field must fail");
  }
});
