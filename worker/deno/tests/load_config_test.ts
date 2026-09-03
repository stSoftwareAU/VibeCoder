/**
 * Tests for the load-config command.
 *
 * Verifies that the command correctly outputs shell variable assignments
 * from configuration files (Issue #904).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { loadConfigCommand } from "../commands/load_config.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { ConfigFile } from "../types.ts";

// Test helper to create a temporary config file
async function withTempConfig(
  config: ConfigFile,
  fn: (configPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  await Deno.writeTextFile(configPath, JSON.stringify(config));
  try {
    await fn(configPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

Deno.test("load-config - outputs shell variable assignments", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["user1", "user2"],
    repos: ["org/repo1"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const dummyConfig = buildDefaultWorkerConfig();
    const result = await loadConfigCommand.execute(
      { "config-path": configPath },
      dummyConfig,
    );

    const output = result.message;

    // Check arrays use conditional assignment
    assert(
      output.includes('ALLOWED_AUTHORS=("user1" "user2")'),
      "Should output ALLOWED_AUTHORS array",
    );
    assert(output.includes('REPOS=("org/repo1")'), "Should output REPOS array");
    // Issue #1834: ISSUE_LABELS hardwired to [top-priority] regardless of input.
    assert(
      output.includes('ISSUE_LABELS=("top-priority")'),
      "Should output hardwired ISSUE_LABELS array",
    );

    // Check legacy scalar uses conditional export
    assert(
      output.includes('ALLOWED_AUTHOR="${ALLOWED_AUTHOR:-user1}"'),
      "Should output legacy ALLOWED_AUTHOR",
    );
  });
});

Deno.test("load-config - a stale fleet_health_* config is refused, never exported (Issue #805)", async () => {
  await withTempConfig(
    {
      allowed_authors: ["user1"],
      repos: ["org/repo1"],
      fleet_health_dir: "/srv/health",
      fleet_health_repo: "git@github.com:org/health.git",
    } as ConfigFile & Record<string, unknown>,
    async (configPath) => {
      const error = await assertRejects(
        () =>
          loadConfigCommand.execute(
            { "config-path": configPath },
            buildDefaultWorkerConfig(),
          ),
        Error,
      );
      assert(error.message.includes("fleet_health_dir"), error.message);
      assert(error.message.includes("callbacks"), error.message);
      assert(!error.message.includes("FLEET_HEALTH_DIR="), error.message);
    },
  );
});

Deno.test("load-config - legacy ALLOWED_AUTHOR scalar tracks allowedAuthors[0] (Issue #3206)", async () => {
  // The legacy scalar is derived from the first entry of the allowedAuthors
  // array, not the deprecated allowedAuthor field.
  const testConfig: ConfigFile = {
    allowed_authors: ["primary-author", "secondary-author"],
    repos: ["org/repo"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const dummyConfig = buildDefaultWorkerConfig();
    const result = await loadConfigCommand.execute(
      { "config-path": configPath },
      dummyConfig,
    );

    assert(
      result.message.includes(
        'ALLOWED_AUTHOR="${ALLOWED_AUTHOR:-primary-author}"',
      ),
      "Legacy ALLOWED_AUTHOR should be the first allowedAuthors entry",
    );
  });
});

Deno.test("load-config - outputs label defaults", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["user1"],
    repos: ["org/repo"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const dummyConfig = buildDefaultWorkerConfig();
    const result = await loadConfigCommand.execute(
      { "config-path": configPath },
      dummyConfig,
    );

    const output = result.message;
    assert(
      output.includes('WORK_ON_LABEL="${WORK_ON_LABEL:-work-on}"'),
      "Should output WORK_ON_LABEL",
    );
    assert(
      output.includes('FAILED_LABEL="${FAILED_LABEL:-failed}"'),
      "Should output FAILED_LABEL",
    );
    assert(
      output.includes('PLANNING_LABEL="${PLANNING_LABEL:-planning}"'),
      "Should output PLANNING_LABEL",
    );
  });
});

Deno.test("load-config - outputs label overrides from config file (Issue #1834: not work_on_label)", async () => {
  // Issue #1834: work_on_label is no longer configurable. failed_label
  // remains overridable.
  const testConfig: ConfigFile = {
    allowed_authors: ["user1"],
    repos: ["org/repo"],
    failed_label: "custom-failed",
  };

  await withTempConfig(testConfig, async (configPath) => {
    const dummyConfig = buildDefaultWorkerConfig();
    const result = await loadConfigCommand.execute(
      { "config-path": configPath },
      dummyConfig,
    );

    const output = result.message;
    assert(
      output.includes('WORK_ON_LABEL="${WORK_ON_LABEL:-work-on}"'),
      "WORK_ON_LABEL is hardwired to work-on",
    );
    assert(
      output.includes('FAILED_LABEL="${FAILED_LABEL:-custom-failed}"'),
      "Should use custom failed label",
    );
  });
});

Deno.test("load-config - outputs operational defaults", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["user1"],
    repos: ["org/repo"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const dummyConfig = buildDefaultWorkerConfig();
    const result = await loadConfigCommand.execute(
      { "config-path": configPath },
      dummyConfig,
    );

    const output = result.message;
    // Issue #1824: claudeTimeout lowered from 14400 to 3600 (1h).
    assert(
      output.includes('CLAUDE_TIMEOUT="${CLAUDE_TIMEOUT:-3600}"'),
      "Should output CLAUDE_TIMEOUT default",
    );
    assert(
      output.includes('SLEEP_INTERVAL="${SLEEP_INTERVAL:-30}"'),
      "Should output SLEEP_INTERVAL default",
    );
    assert(
      output.includes(
        'MAX_CLARIFICATION_ROUNDS="${MAX_CLARIFICATION_ROUNDS:-3}"',
      ),
      "Should output MAX_CLARIFICATION_ROUNDS default",
    );
  });
});

Deno.test("load-config - outputs operational overrides from config", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["user1"],
    repos: ["org/repo"],
    claude_timeout: 7200,
    sleep_interval: 60,
  };

  await withTempConfig(testConfig, async (configPath) => {
    const dummyConfig = buildDefaultWorkerConfig();
    const result = await loadConfigCommand.execute(
      { "config-path": configPath },
      dummyConfig,
    );

    const output = result.message;
    assert(
      output.includes('CLAUDE_TIMEOUT="${CLAUDE_TIMEOUT:-7200}"'),
      "Should output overridden CLAUDE_TIMEOUT",
    );
    assert(
      output.includes('SLEEP_INTERVAL="${SLEEP_INTERVAL:-60}"'),
      "Should output overridden SLEEP_INTERVAL",
    );
  });
});

Deno.test("load-config - outputs PR reviewers array", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["user1"],
    repos: ["org/repo"],
    pr_reviewers: ["reviewer1", "reviewer2"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const dummyConfig = buildDefaultWorkerConfig();
    const result = await loadConfigCommand.execute(
      { "config-path": configPath },
      dummyConfig,
    );

    const output = result.message;
    assert(
      output.includes('PR_REVIEWERS=("reviewer1" "reviewer2")'),
      "Should output PR_REVIEWERS array",
    );
    assert(
      output.includes('PR_REVIEWER="${PR_REVIEWER:-reviewer1}"'),
      "Should output legacy PR_REVIEWER",
    );
  });
});

Deno.test("load-config - outputs toggle defaults", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["user1"],
    repos: ["org/repo"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const dummyConfig = buildDefaultWorkerConfig();
    const result = await loadConfigCommand.execute(
      { "config-path": configPath },
      dummyConfig,
    );

    const output = result.message;
    assert(
      output.includes('SHUFFLE_REPOS="${SHUFFLE_REPOS:-true}"'),
      "Should output SHUFFLE_REPOS default",
    );
    assert(
      output.includes('UPDATE_GH_USER_STATUS="${UPDATE_GH_USER_STATUS:-true}"'),
      "Should output UPDATE_GH_USER_STATUS default",
    );
    assert(
      output.includes('SET_WINDOW_TITLE="${SET_WINDOW_TITLE:-true}"'),
      "Should output SET_WINDOW_TITLE default",
    );
  });
});

Deno.test("load-config - escapes special characters in values", async () => {
  // Issue #1834: work_on_label is no longer accepted; use failed_label
  // (a still-configurable label) to exercise the escape path.
  const testConfig: ConfigFile = {
    allowed_authors: ["user1"],
    repos: ["org/repo"],
    failed_label: 'label with "quotes"',
  };

  await withTempConfig(testConfig, async (configPath) => {
    const dummyConfig = buildDefaultWorkerConfig();
    const result = await loadConfigCommand.execute(
      { "config-path": configPath },
      dummyConfig,
    );

    const output = result.message;
    // Should escape double quotes
    assert(
      output.includes('label with \\"quotes\\"'),
      "Should escape double quotes in values",
    );
  });
});

Deno.test("load-config - returns defaults when config file missing", async () => {
  const dummyConfig = buildDefaultWorkerConfig();
  const result = await loadConfigCommand.execute(
    { "config-path": "/nonexistent/.config.json" },
    dummyConfig,
  );

  const output = result.message;
  // Should still produce output with defaults
  // Issue #1824: claudeTimeout lowered from 14400 to 3600 (1h).
  assert(
    output.includes('CLAUDE_TIMEOUT="${CLAUDE_TIMEOUT:-3600}"'),
    "Should output default CLAUDE_TIMEOUT",
  );
  // Issue #1834: ISSUE_LABELS hardwired to [top-priority].
  assert(
    output.includes('ISSUE_LABELS=("top-priority")'),
    "Should output hardwired ISSUE_LABELS",
  );
});

Deno.test("load-config - outputs shell defaults for additional variables", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["user1"],
    repos: ["org/repo"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const dummyConfig = buildDefaultWorkerConfig();
    const result = await loadConfigCommand.execute(
      { "config-path": configPath },
      dummyConfig,
    );

    const output = result.message;
    // Check additional shell defaults that were in config_defaults.sh
    assert(
      output.includes(
        'CIRCUIT_BREAKER_THRESHOLD="${CIRCUIT_BREAKER_THRESHOLD:-3}"',
      ),
      "Should output CIRCUIT_BREAKER_THRESHOLD",
    );
    assert(
      output.includes('STUCK_ISSUE_TIMEOUT="${STUCK_ISSUE_TIMEOUT:-7200}"'),
      "Should output STUCK_ISSUE_TIMEOUT",
    );
    assert(
      output.includes('LOG_MAX_SIZE_MB="${LOG_MAX_SIZE_MB:-10}"'),
      "Should output LOG_MAX_SIZE_MB",
    );
    assert(
      output.includes('CLAIM_CHURN_THRESHOLD="${CLAIM_CHURN_THRESHOLD:-5}"'),
      "Should output CLAIM_CHURN_THRESHOLD",
    );
  });
});

Deno.test("load-config - arrays are set unconditionally without guards", async () => {
  // Regression test: arrays must NOT use conditional guards like
  // if [[ -z "${VAR+x}" ]]; then ... fi
  // because config_defaults.sh sets these arrays to empty values first,
  // causing the guard to skip the config-file values on bash 4+.
  const testConfig: ConfigFile = {
    allowed_authors: ["user1"],
    repos: ["org/repo1", "org/repo2"],
    pr_reviewers: ["reviewer1"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const dummyConfig = buildDefaultWorkerConfig();
    const result = await loadConfigCommand.execute(
      { "config-path": configPath },
      dummyConfig,
    );

    const output = result.message;
    const arrayNames = [
      "REPOS",
      "ALLOWED_AUTHORS",
      "ISSUE_LABELS",
      "PR_REVIEWERS",
      "AUTHORIZED_COMMENTERS",
    ];
    for (const name of arrayNames) {
      assert(
        !output.includes(`if [[ -z "\${${name}+x}" ]]`),
        `${name} must be set unconditionally — guards cause config_defaults.sh to shadow config values`,
      );
      assert(
        output.includes(`${name}=(`),
        `${name} must be present as a direct array assignment`,
      );
    }
  });
});

Deno.test("load-config - arrays override pre-existing empty values when eval'd", async () => {
  // Integration regression test: simulates the real loading sequence where
  // config_defaults.sh sets REPOS=() before the Deno output is eval'd.
  const testConfig: ConfigFile = {
    allowed_authors: ["user1"],
    repos: ["org/repo1"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const dummyConfig = buildDefaultWorkerConfig();
    const result = await loadConfigCommand.execute(
      { "config-path": configPath },
      dummyConfig,
    );

    const cmd = new Deno.Command("bash", {
      args: [
        "-c",
        `
        set -euo pipefail
        REPOS=()
        ALLOWED_AUTHORS=()
        ISSUE_LABELS=()
        eval '${result.message.replace(/'/g, "'\\''")}'
        if [[ \${#REPOS[@]} -eq 0 ]]; then
          echo "FAIL: REPOS is empty after eval"
          exit 1
        fi
        if [[ \${#ALLOWED_AUTHORS[@]} -eq 0 ]]; then
          echo "FAIL: ALLOWED_AUTHORS is empty after eval"
          exit 1
        fi
        echo "OK: REPOS=\${REPOS[*]} AUTHORS=\${ALLOWED_AUTHORS[*]}"
      `,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    assert(output.success, `Config eval failed: ${stderr} ${stdout}`);
    assert(stdout.includes("OK:"), `Expected OK output, got: ${stdout}`);
  });
});

Deno.test("load-config - outputs GitHub App config fields", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["user1"],
    repos: ["org/repo"],
    github_app_id: "12345",
    github_app_installation_id: "67890",
    github_app_private_key_path: "/path/to/key.pem",
  };

  await withTempConfig(testConfig, async (configPath) => {
    const dummyConfig = buildDefaultWorkerConfig();
    const result = await loadConfigCommand.execute(
      { "config-path": configPath },
      dummyConfig,
    );

    const output = result.message;
    assert(
      output.includes('GITHUB_APP_ID="${GITHUB_APP_ID:-12345}"'),
      "Should output GITHUB_APP_ID",
    );
    assert(
      output.includes(
        'GITHUB_APP_INSTALLATION_ID="${GITHUB_APP_INSTALLATION_ID:-67890}"',
      ),
      "Should output GITHUB_APP_INSTALLATION_ID",
    );
    assert(
      output.includes(
        'GITHUB_APP_PRIVATE_KEY_PATH="${GITHUB_APP_PRIVATE_KEY_PATH:-/path/to/key.pem}"',
      ),
      "Should output GITHUB_APP_PRIVATE_KEY_PATH",
    );
  });
});

Deno.test("load-config - omits GitHub App fields when not configured", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["user1"],
    repos: ["org/repo"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const dummyConfig = buildDefaultWorkerConfig();
    const result = await loadConfigCommand.execute(
      { "config-path": configPath },
      dummyConfig,
    );

    const output = result.message;
    assert(
      !output.includes("GITHUB_APP_ID"),
      "Should not output GITHUB_APP_ID when not configured",
    );
    assert(
      !output.includes("GITHUB_APP_INSTALLATION_ID"),
      "Should not output GITHUB_APP_INSTALLATION_ID when not configured",
    );
    assert(
      !output.includes("GITHUB_APP_PRIVATE_KEY_PATH"),
      "Should not output GITHUB_APP_PRIVATE_KEY_PATH when not configured",
    );
  });
});

Deno.test("load-config - expands tilde in GitHub App private key path", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["user1"],
    repos: ["org/repo"],
    github_app_id: "12345",
    github_app_installation_id: "67890",
    github_app_private_key_path: "~/keys/app.pem",
  };

  await withTempConfig(testConfig, async (configPath) => {
    const dummyConfig = buildDefaultWorkerConfig();
    const result = await loadConfigCommand.execute(
      { "config-path": configPath },
      dummyConfig,
    );

    const output = result.message;
    const home = Deno.env.get("HOME") ?? "";
    assert(
      output.includes(`${home}/keys/app.pem`),
      "Should expand ~ in private key path",
    );
    assert(
      !output.includes("~/keys/app.pem"),
      "Should not contain unexpanded tilde",
    );
  });
});

Deno.test("load-config - validation returns errors for invalid config", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["invalid user!"],
    repos: ["not-valid"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const dummyConfig = buildDefaultWorkerConfig();
    const result = await loadConfigCommand.execute(
      { "config-path": configPath },
      dummyConfig,
    );

    // Should report failure but still produce output
    assertEquals(result.success, false);
    assert(result.message.length > 0, "Should still produce shell output");
  });
});

Deno.test("load-config - exports the progress-extension keys for bash consumers (Issue #4295)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["user1"],
    repos: ["org/repo"],
    progress_extension_enabled: true,
    progress_extension_grant_seconds: 600,
    progress_extension_stall_seconds: 240,
    progress_extension_check_seconds: 120,
  };

  await withTempConfig(testConfig, async (configPath) => {
    const dummyConfig = buildDefaultWorkerConfig();
    const result = await loadConfigCommand.execute(
      { "config-path": configPath },
      dummyConfig,
    );

    const output = result.message;
    for (
      const expected of [
        'export PROGRESS_EXTENSION_ENABLED="${PROGRESS_EXTENSION_ENABLED:-true}"',
        'export PROGRESS_EXTENSION_GRANT_SECONDS="${PROGRESS_EXTENSION_GRANT_SECONDS:-600}"',
        'export PROGRESS_EXTENSION_STALL_SECONDS="${PROGRESS_EXTENSION_STALL_SECONDS:-240}"',
        'export PROGRESS_EXTENSION_CHECK_SECONDS="${PROGRESS_EXTENSION_CHECK_SECONDS:-120}"',
      ]
    ) {
      assert(output.includes(expected), `Should output: ${expected}`);
    }
  });
});

// Issue #422 flipped the shipped default from `false` to `true`, so the
// exported value for an unset key changed with it. The assertion's purpose is
// unchanged: bash must see exactly what the Deno runner decided with.
Deno.test("load-config - the progress-extension defaults are exported when unset (Issues #4295, #422)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["user1"],
    repos: ["org/repo"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const dummyConfig = buildDefaultWorkerConfig();
    const result = await loadConfigCommand.execute(
      { "config-path": configPath },
      dummyConfig,
    );

    const output = result.message;
    assert(
      output.includes(
        'export PROGRESS_EXTENSION_ENABLED="${PROGRESS_EXTENSION_ENABLED:-true}"',
      ),
      "the feature ships on, so the exported default is true",
    );
    assert(
      output.includes(
        'export PROGRESS_EXTENSION_CHECK_SECONDS="${PROGRESS_EXTENSION_CHECK_SECONDS:-300}"',
      ),
      "the documented check-interval default must reach bash",
    );
  });
});
