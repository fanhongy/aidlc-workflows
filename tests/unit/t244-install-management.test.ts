// covers: tool:aidlc-lifecycle, tool:aidlc-machine-config, tool:aidlc-update
// covers: tool:aidlc-completions, file:scripts/install.sh, file:scripts/install.ps1

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeExecutablePath,
  commandPath,
  readActiveExecutable,
  windowsUninstallFencePath,
} from "../../core/tools/aidlc-install-paths.ts";
import { doctorUpdateState } from "../../core/tools/aidlc-doctor.ts";
import { activate } from "../../core/tools/aidlc-lifecycle.ts";
import {
  readMachineConfig,
  resolvedReleaseSettings,
} from "../../core/tools/aidlc-machine-config.ts";
import {
  cachedUpdateNotice,
  readUpdateCache,
  refreshUpdateState,
} from "../../core/tools/aidlc-update.ts";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import { scanWindowsUninstallJournals } from "../../core/tools/aidlc-windows-uninstall.ts";
import {
  serveReleaseFixture,
  writeReleaseFixture,
} from "../harness/release-fixture.ts";

const REPO_ROOT = join(fileURLToPath(new URL("../..", import.meta.url)));
const DISPATCHER = join(REPO_ROOT, "core", "tools", "aidlc.ts");
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const LIFECYCLE = join(REPO_ROOT, "core", "tools", "aidlc-lifecycle.ts");
const INSTALL_SH = join(REPO_ROOT, "scripts", "install.sh");
const INSTALL_PS1 = join(REPO_ROOT, "scripts", "install.ps1");
const temporary: string[] = [];
function patchVersion(offset: number): string {
  const [major, minor, patch] = AIDLC_VERSION.split(".").map(Number);
  return `${major}.${minor}.${patch + offset}`;
}
const NEXT_VERSION = patchVersion(1);
const LIVE_PIN_VERSION = patchVersion(2);
const STALE_PIN_VERSION = patchVersion(3);
const REMOVABLE_VERSION = patchVersion(4);

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function run(
  tool: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [tool, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function runAsync(
  tool: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, tool, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

function fixture(version = AIDLC_VERSION): string {
  const root = temp("aidlc-t241-release-");
  writeReleaseFixture({
    root,
    repoRoot: REPO_ROOT,
    version,
  });
  return root;
}

function envFor(machine: string): NodeJS.ProcessEnv {
  return {
    AIDLC_INSTALL_ROOT: machine,
    AIDLC_BIN_DIR: join(machine, "bin"),
  };
}

describe("t244 machine configuration and update discovery", () => {
  test("global config works outside projects and precedence is flag, env, config, default", () => {
    const machine = temp("aidlc-t241-config-");
    const cwd = temp("aidlc-t241-config-cwd-");
    const env = envFor(machine);
    expect(run(DISPATCHER, [
      "system",
      "config", "global", "set", "offline", "on",
    ], cwd, env).status).toBe(0);
    expect(run(DISPATCHER, [
      "system",
      "config", "global", "set", "release-base-url", "https://mirror.example/releases",
    ], cwd, env).status).toBe(0);

    const prior = {
      install: process.env.AIDLC_INSTALL_ROOT,
      bin: process.env.AIDLC_BIN_DIR,
      offline: process.env.AIDLC_OFFLINE,
      base: process.env.AIDLC_RELEASE_BASE_URL,
    };
    process.env.AIDLC_INSTALL_ROOT = machine;
    process.env.AIDLC_BIN_DIR = join(machine, "bin");
    try {
      expect(readMachineConfig()).toEqual({
        schemaVersion: 1,
        offline: true,
        "release-base-url": "https://mirror.example/releases",
      });
      expect(resolvedReleaseSettings()).toEqual({
        offline: true,
        baseUrl: "https://mirror.example/releases",
        caBundle: undefined,
      });
      process.env.AIDLC_OFFLINE = "0";
      process.env.AIDLC_RELEASE_BASE_URL = "https://env.example/releases";
      expect(resolvedReleaseSettings()).toEqual({
        offline: false,
        baseUrl: "https://env.example/releases",
        caBundle: undefined,
      });
      expect(resolvedReleaseSettings({
        offline: true,
        baseUrl: "https://flag.example/releases",
      })).toEqual({
        offline: true,
        baseUrl: "https://flag.example/releases",
        caBundle: undefined,
      });
    } finally {
      for (const [key, value] of Object.entries({
        AIDLC_INSTALL_ROOT: prior.install,
        AIDLC_BIN_DIR: prior.bin,
        AIDLC_OFFLINE: prior.offline,
        AIDLC_RELEASE_BASE_URL: prior.base,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("machine config rejects release URLs with secrets in query or fragment", () => {
    const machine = temp("aidlc-t240-config-url-");
    const cwd = temp("aidlc-t240-config-url-cwd-");
    const env = envFor(machine);
    const rejected = run(DISPATCHER, [
      "system",
      "config",
      "global",
      "set",
      "release-base-url",
      "https://mirror.example/releases?token=secret#private",
    ], cwd, env);
    expect(rejected.status).toBe(2);
    expect(rejected.stdout + rejected.stderr).not.toContain("token=secret");
    expect(rejected.stdout + rejected.stderr).not.toContain("private");
    expect(existsSync(join(machine, "config.json"))).toBe(false);
  });

  test("doctor explicit refresh honors its mirror and quiet modes stay network-free", async () => {
    const release = fixture(NEXT_VERSION);
    const server = serveReleaseFixture(release);
    const machine = temp("aidlc-t240-doctor-update-");
    const keys = [
      "AIDLC_INSTALL_ROOT",
      "AIDLC_BIN_DIR",
      "AIDLC_RELEASE_BASE_URL",
      "AIDLC_OFFLINE",
      "NO_PROXY",
    ] as const;
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      ...envFor(machine),
      AIDLC_RELEASE_BASE_URL: "https://ignored.example/releases",
      AIDLC_OFFLINE: "0",
      NO_PROXY: "127.0.0.1",
    });
    try {
      const state = await doctorUpdateState({
        "check-updates": "true",
        "release-base-url": server.baseUrl,
      }, false);
      expect(state.state).toBe("behind");
      expect(server.requests.filter((path) => path.endsWith("/version.json")))
        .toHaveLength(1);
      expect(server.requests.filter((path) => path.endsWith("/checksums.txt")))
        .toHaveLength(1);

      server.requests.length = 0;
      const routed = await runAsync(DISPATCHER, [
        "doctor",
        "--check-updates",
        "--release-base-url",
        server.baseUrl,
        "--json",
        "--project-dir",
        REPO_ROOT,
      ], REPO_ROOT, {
        ...envFor(machine),
        AIDLC_OFFLINE: "0",
        NO_PROXY: "127.0.0.1",
      });
      expect([0, 1]).toContain(routed.status);
      expect(JSON.parse(routed.stdout).data.checks).toContainEqual(
        expect.objectContaining({
          label: expect.stringContaining(`latest ${NEXT_VERSION}`),
        }),
      );
      expect(server.requests.filter((path) => path.endsWith("/version.json")))
        .toHaveLength(1);
      expect(server.requests.filter((path) => path.endsWith("/checksums.txt")))
        .toHaveLength(1);

      rmSync(join(machine, "update-check.json"), { force: true });
      server.requests.length = 0;
      await doctorUpdateState({ "release-base-url": server.baseUrl }, false);
      await doctorUpdateState({
        json: "true",
        "release-base-url": server.baseUrl,
      }, true);
      await doctorUpdateState({
        quiet: "true",
        "release-base-url": server.baseUrl,
      }, true);
      expect(server.requests).toHaveLength(0);
    } finally {
      server.stop();
      for (const key of keys) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 10_000);

  test("interactive doctor bounds a missing-cache refresh to 750 milliseconds", async () => {
    const release = fixture(NEXT_VERSION);
    const server = serveReleaseFixture(release, {
      kind: "delay",
      asset: "version.json",
      milliseconds: 2_000,
    });
    const machine = temp("aidlc-t240-doctor-timeout-");
    const keys = [
      "AIDLC_INSTALL_ROOT",
      "AIDLC_BIN_DIR",
      "AIDLC_RELEASE_BASE_URL",
      "AIDLC_OFFLINE",
      "NO_PROXY",
    ] as const;
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      ...envFor(machine),
      AIDLC_OFFLINE: "0",
      NO_PROXY: "127.0.0.1",
    });
    try {
      const started = performance.now();
      const state = await doctorUpdateState({
        "release-base-url": server.baseUrl,
      }, true);
      const elapsed = performance.now() - started;
      expect(state.state).toBe("unavailable");
      expect(elapsed).toBeGreaterThanOrEqual(500);
      expect(elapsed).toBeLessThan(1_500);
    } finally {
      server.stop();
      for (const key of keys) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 5_000);

  test("authenticated refresh replaces the cache and every failed refresh preserves it", async () => {
    const release = fixture(NEXT_VERSION);
    const server = serveReleaseFixture(release);
    const machine = temp("aidlc-t241-update-");
    const saved = Object.fromEntries(
      ["AIDLC_INSTALL_ROOT", "AIDLC_BIN_DIR", "AIDLC_RELEASE_BASE_URL", "NO_PROXY"]
        .map((key) => [key, process.env[key]]),
    );
    process.env.AIDLC_INSTALL_ROOT = machine;
    process.env.AIDLC_BIN_DIR = join(machine, "bin");
    process.env.AIDLC_RELEASE_BASE_URL = server.baseUrl;
    process.env.NO_PROXY = "127.0.0.1";
    try {
      const state = await refreshUpdateState(15_000);
      expect(state.state).toBe("behind");
      expect(readUpdateCache()?.latestVersion).toBe(NEXT_VERSION);
      expect(cachedUpdateNotice()).toContain(`aidlc ${NEXT_VERSION}`);
      expect(server.requests.filter((path) => path.endsWith("version.json"))).toHaveLength(1);
      expect(server.requests.filter((path) => path.endsWith("checksums.txt"))).toHaveLength(1);

      const before = readFileSync(join(machine, "update-check.json"), "utf-8");
      server.stop();
      const captive = serveReleaseFixture(release, {
        kind: "captive-portal",
        asset: "version.json",
      });
      process.env.AIDLC_RELEASE_BASE_URL = captive.baseUrl;
      const unavailable = await refreshUpdateState(15_000);
      expect(unavailable.state).toBe("unavailable");
      expect(readFileSync(join(machine, "update-check.json"), "utf-8")).toBe(before);
      captive.stop();
    } finally {
      server.stop();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("older authenticated metadata cannot replace a newer valid update cache", async () => {
    const newerRelease = fixture(NEXT_VERSION);
    const olderRelease = fixture("0.0.1");
    const newerServer = serveReleaseFixture(newerRelease);
    const olderServer = serveReleaseFixture(olderRelease);
    const machine = temp("aidlc-t241-update-downgrade-");
    const saved = Object.fromEntries(
      ["AIDLC_INSTALL_ROOT", "AIDLC_BIN_DIR", "AIDLC_RELEASE_BASE_URL", "NO_PROXY"]
        .map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, {
      ...envFor(machine),
      AIDLC_RELEASE_BASE_URL: newerServer.baseUrl,
      NO_PROXY: "127.0.0.1",
    });
    try {
      expect((await refreshUpdateState(15_000)).state).toBe("behind");
      const before = readFileSync(join(machine, "update-check.json"), "utf-8");
      process.env.AIDLC_RELEASE_BASE_URL = olderServer.baseUrl;

      const state = await refreshUpdateState(15_000);
      expect(state.state).toBe("unavailable");
      expect(state.latestVersion).toBe(NEXT_VERSION);
      expect(readFileSync(join(machine, "update-check.json"), "utf-8")).toBe(before);
      expect(readUpdateCache()?.latestVersion).toBe(NEXT_VERSION);
    } finally {
      newerServer.stop();
      olderServer.stop();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("disabled and offline update checks open no socket", async () => {
    const release = fixture(NEXT_VERSION);
    const server = serveReleaseFixture(release);
    const machine = temp("aidlc-t241-no-socket-");
    const env = {
      ...envFor(machine),
      AIDLC_RELEASE_BASE_URL: server.baseUrl,
      NO_PROXY: "127.0.0.1",
    };
    const saved = Object.fromEntries(
      ["AIDLC_INSTALL_ROOT", "AIDLC_BIN_DIR", "AIDLC_RELEASE_BASE_URL", "NO_PROXY"]
        .map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, env);
    try {
      expect((await refreshUpdateState(50, {
        offline: true,
        baseUrl: server.baseUrl,
      })).state).toBe("offline");
      expect(server.requests).toHaveLength(0);
      expect(run(DISPATCHER, [
      "system",
      "config", "global", "set", "update-check", "off",
      ], REPO_ROOT, env).status).toBe(0);
      expect((await refreshUpdateState(50)).state).toBe("disabled");
      const disabledCheck = run(
        DISPATCHER,
        ["update", "--check"],
        REPO_ROOT,
        env,
      );
      expect(disabledCheck.status).toBe(1);
      expect(server.requests).toHaveLength(0);
      expect(run(DISPATCHER, [
      "system",
      "config", "global", "set", "update-check", "on",
      ], REPO_ROOT, env).status).toBe(0);
      expect(run(DISPATCHER, [
      "system",
      "config", "global", "set", "offline", "on",
      ], REPO_ROOT, env).status).toBe(0);
      expect((await refreshUpdateState(50)).state).toBe("offline");
      const offlineCheck = run(
        DISPATCHER,
        ["update", "--check"],
        REPO_ROOT,
        env,
      );
      expect(offlineCheck.status).toBe(3);
      expect(server.requests).toHaveLength(0);
    } finally {
      server.stop();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("t244 management lifecycle", () => {
  test("malformed pin entries warn without hiding valid registrations", () => {
    const machine = temp("aidlc-t241-malformed-pins-");
    const project = temp("aidlc-t241-malformed-pins-project-");
    const pinnedProject = temp("aidlc-t241-valid-pin-project-");
    const version = "9.8.7";
    mkdirSync(join(machine, "versions", version), { recursive: true });
    writeFileSync(join(pinnedProject, ".aidlc-version"), `${version}\n`);
    writeFileSync(
      join(machine, "pins.json"),
      `${JSON.stringify({
        [pinnedProject]: version,
        relative: "not-semver",
      }, null, 2)}\n`,
    );
    const env = envFor(machine);

    const list = run(LIFECYCLE, ["versions", "list", "--json"], project, env);
    expect(list.status, list.stdout + list.stderr).toBe(0);
    const data = JSON.parse(list.stdout).data as {
      versions: Array<{ version: string; pinPaths: string[] }>;
      pinWarnings: string[];
    };
    expect(data.versions).toContainEqual(expect.objectContaining({
      version,
      pinPaths: [pinnedProject],
    }));
    expect(data.pinWarnings).toEqual([
      expect.stringContaining("invalid pin entry for relative"),
    ]);

    const rollback = run(LIFECYCLE, ["rollback", "--list"], project, env);
    expect(rollback.status).toBe(0);
    expect(rollback.stdout).toContain("warning:");
    const prune = run(LIFECYCLE, ["versions", "prune", "--yes"], project, env);
    expect(prune.status).toBe(4);
    expect(prune.stdout).toContain("cannot prune while pin registry is invalid");
    expect(existsSync(join(machine, "versions", version))).toBe(true);
  });

  test("doctor reports quarantined transaction recovery with manual cleanup", () => {
    const release = fixture();
    const sandbox = temp("aidlc-t244-doctor-recovery-");
    const machine = join(sandbox, "home", ".local", "share", "aidlc");
    const project = temp("aidlc-t244-doctor-recovery-project-");
    const env = {
      AIDLC_INSTALL_ROOT: machine,
      AIDLC_BIN_DIR: join(sandbox, "home", ".local", "bin"),
    };
    mkdirSync(join(project, ".git"));
    const installed = run(LIFECYCLE, [
      "update", "--version", AIDLC_VERSION, "--from", release,
    ], project, env);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);

    const quarantine = join(
      machine,
      `.aidlc-recovery-${Date.now()}-${randomUUID()}`,
    );
    mkdirSync(quarantine);
    writeFileSync(join(quarantine, "candidate.txt"), "recovery evidence\n");

    const doctor = run(
      DISPATCHER,
      ["doctor", "--json", "--project-dir", project],
      project,
      env,
    );
    expect(doctor.status).toBe(1);
    const checks = (JSON.parse(doctor.stdout) as {
      data: { checks: Array<{ pass: boolean; label: string; fix?: string }> };
    }).data.checks;
    expect(checks).toContainEqual(expect.objectContaining({
      pass: true,
      label: "Transaction staging: no abandoned directories",
    }));
    expect(checks).toContainEqual(expect.objectContaining({
      pass: false,
      label: expect.stringContaining(
        `Transaction recovery: 1 quarantined path(s): ${quarantine}`,
      ),
      fix: expect.stringContaining(
        "recover any needed files, then remove the directory manually",
      ),
    }));

    rmSync(quarantine, { recursive: true });
    const clean = run(
      DISPATCHER,
      ["doctor", "--json", "--project-dir", project],
      project,
      env,
    );
    const cleanChecks = (JSON.parse(clean.stdout) as {
      data: { checks: Array<{ pass: boolean; label: string }> };
    }).data.checks;
    expect(cleanChecks).toContainEqual(expect.objectContaining({
      pass: true,
      label: "Transaction recovery: no quarantined directories",
    }));

    // Project-domain transactions (init, plugin sync) quarantine into the
    // project root; doctor must see those on every channel, machine install
    // or not.
    const projectQuarantine = join(
      project,
      `.aidlc-recovery-${Date.now()}-${randomUUID()}`,
    );
    mkdirSync(projectQuarantine);
    writeFileSync(join(projectQuarantine, "candidate.txt"), "recovery evidence\n");
    const projectDoctor = run(
      DISPATCHER,
      ["doctor", "--json", "--project-dir", project],
      project,
      env,
    );
    const projectChecks = (JSON.parse(projectDoctor.stdout) as {
      data: { checks: Array<{ pass: boolean; label: string }> };
    }).data.checks;
    expect(projectChecks).toContainEqual(expect.objectContaining({
      pass: false,
      label: expect.stringContaining(
        `Transaction recovery: 1 quarantined path(s): ${projectQuarantine}`,
      ),
    }));

    const sourceChannelDoctor = run(
      DISPATCHER,
      ["doctor", "--json", "--project-dir", project],
      project,
      {
        AIDLC_INSTALL_ROOT: join(sandbox, "absent", "share", "aidlc"),
        AIDLC_BIN_DIR: join(sandbox, "absent", "bin"),
      },
    );
    const sourceChecks = (JSON.parse(sourceChannelDoctor.stdout) as {
      data: { checks: Array<{ pass: boolean; label: string }> };
    }).data.checks;
    expect(sourceChecks).toContainEqual(expect.objectContaining({
      pass: false,
      label: expect.stringContaining(
        `Transaction recovery: 1 quarantined path(s): ${projectQuarantine}`,
      ),
    }));
  }, 60_000);

  test("all harness runtimes install together and config selects one project harness", () => {
    const release = fixture();
    const machine = temp("aidlc-t241-all-harness-");
    const project = temp("aidlc-t241-all-harness-project-");
    mkdirSync(join(project, ".git"));
    const env = envFor(machine);
    const installed = run(LIFECYCLE, [
      "update", "--version", AIDLC_VERSION, "--from", release,
    ], project, env);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
    for (const harness of ["claude", "codex", "kiro", "kiro-ide", "opencode"]) {
      expect(existsSync(join(machine, "versions", AIDLC_VERSION, "runtime", harness))).toBe(true);
    }
    for (const file of ["aidlc.bash", "_aidlc", "aidlc.fish", "aidlc.ps1"]) {
      expect(existsSync(join(machine, "completions", file)), file).toBe(true);
    }
    expect(
      existsSync(join(machine, "versions", AIDLC_VERSION, "plugins", "test-pro", "claude")),
    ).toBe(true);
    const missingChoice = run(DISPATCHER, [
      "config", "--project-dir", project, "--mcp", "none",
    ], project, env);
    expect(missingChoice.status).toBe(2);
    expect(missingChoice.stdout + missingChoice.stderr).toContain("--harness");
    const configured = run(DISPATCHER, [
      "config", "--project-dir", project, "--harness", "kiro", "--mcp", "none",
    ], project, env);
    expect(configured.status, configured.stdout + configured.stderr).toBe(0);
    expect(existsSync(join(project, ".kiro"))).toBe(true);
    const multi = run(DISPATCHER, [
      "config", "--project-dir", temp("aidlc-t241-multi-project-"),
      "--harness", "claude", "--harness", "kiro", "--mcp", "none",
    ], project, env);
    expect(multi.status).toBe(2);
    expect(multi.stdout + multi.stderr).toContain("multi-harness config is not supported yet");
  }, 60_000);

  test("a missing declared runtime makes the retained version incomplete", () => {
    const release = fixture();
    const machine = temp("aidlc-t244-missing-runtime-");
    const project = temp("aidlc-t244-missing-runtime-project-");
    mkdirSync(join(project, ".git"));
    const env = envFor(machine);
    expect(run(LIFECYCLE, [
      "update", "--version", AIDLC_VERSION, "--from", release,
    ], project, env).status).toBe(0);
    rmSync(join(machine, "versions", AIDLC_VERSION, "runtime", "codex"), {
      recursive: true,
    });
    const listed = run(LIFECYCLE, ["versions", "list", "--json"], project, env);
    expect(listed.stdout).toContain('"complete":false');
    expect(run(LIFECYCLE, ["use", AIDLC_VERSION], project, env).status).toBe(4);
  }, 60_000);

  test("update retains the prior active and pinned versions while pruning older versions", () => {
    const release = fixture();
    const nextRelease = fixture(NEXT_VERSION);
    const livePinRelease = fixture(LIVE_PIN_VERSION);
    const stalePinRelease = fixture(STALE_PIN_VERSION);
    const removableRelease = fixture(REMOVABLE_VERSION);
    const machine = temp("aidlc-t241-prune-");
    const project = temp("aidlc-t241-prune-project-");
    const pinnedProject = temp("aidlc-t241-live-pin-");
    mkdirSync(join(project, ".git"));
    mkdirSync(join(pinnedProject, ".git"));
    const env = envFor(machine);
    expect(run(LIFECYCLE, [
      "update", "--version", AIDLC_VERSION, "--from", release,
    ], project, env).status).toBe(0);
    expect(run(LIFECYCLE, [
      "versions", "install", LIVE_PIN_VERSION, "--from", livePinRelease,
    ], project, env).status).toBe(0);
    expect(run(LIFECYCLE, [
      "versions", "install", STALE_PIN_VERSION, "--from", stalePinRelease,
    ], project, env).status).toBe(0);
    expect(run(LIFECYCLE, [
      "versions", "install", REMOVABLE_VERSION, "--from", removableRelease,
    ], project, env).status).toBe(0);
    const pinned = run(INIT, [
      "config",
      "--pin",
      LIVE_PIN_VERSION,
      "--project-dir",
      pinnedProject,
    ], pinnedProject, env);
    expect(pinned.status, pinned.stdout + pinned.stderr).toBe(0);
    const pins = JSON.parse(
      readFileSync(join(machine, "pins.json"), "utf-8"),
    ) as Record<string, string>;
    pins["/missing/stale-project"] = STALE_PIN_VERSION;
    writeFileSync(join(machine, "pins.json"), `${JSON.stringify(pins, null, 2)}\n`);
    const updated = run(LIFECYCLE, [
      "update", "--version", NEXT_VERSION, "--from", nextRelease,
    ], project, env);
    expect(updated.status, updated.stdout + updated.stderr).toBe(0);
    expect(updated.stdout).toContain(`updated ${AIDLC_VERSION} -> ${NEXT_VERSION}`);
    expect(updated.stdout).toContain(`pruned ${REMOVABLE_VERSION}`);
    for (const version of [AIDLC_VERSION, NEXT_VERSION, LIVE_PIN_VERSION, STALE_PIN_VERSION]) {
      expect(existsSync(join(machine, "versions", version))).toBe(true);
    }
    expect(existsSync(join(machine, "versions", REMOVABLE_VERSION))).toBe(false);
  }, 120_000);

  test("uninstall removes command and versions while preserving machine state and projects", () => {
    const release = fixture();
    const machine = temp("aidlc-t241-uninstall-");
    const project = temp("aidlc-t241-uninstall-project-");
    mkdirSync(join(project, ".git"));
    writeFileSync(join(project, "keep.txt"), "project-owned\n");
    const env = envFor(machine);
    expect(run(LIFECYCLE, [
      "update", "--version", AIDLC_VERSION, "--from", release,
    ], project, env).status).toBe(0);
    const command = join(machine, "bin", "aidlc");
    const executable = join(machine, "versions", AIDLC_VERSION, "aidlc");
    rmSync(command);
    writeFileSync(command, "user-owned command\n");
    const mixedOwnership = run(
      LIFECYCLE,
      ["uninstall", "--yes"],
      project,
      env,
    );
    expect(mixedOwnership.status).toBe(4);
    expect(readFileSync(command, "utf-8")).toBe("user-owned command\n");
    rmSync(command);
    symlinkSync(executable, command);
    expect(run(DISPATCHER, [
      "system",
      "config", "global", "set", "offline", "on",
    ], project, env).status).toBe(0);
    writeFileSync(join(machine, "update-check.json"), "{}\n");
    writeFileSync(join(machine, "pins.json"), "{}\n");

    expect(run(LIFECYCLE, ["uninstall"], project, env).status).toBe(2);
    expect(run(LIFECYCLE, ["uninstall", "--yes"], project, env).status).toBe(0);
    expect(existsSync(join(machine, "versions"))).toBe(false);
    expect(existsSync(command)).toBe(false);
    expect(existsSync(join(machine, "config.json"))).toBe(true);
    expect(existsSync(join(machine, "update-check.json"))).toBe(true);
    expect(existsSync(join(machine, "pins.json"))).toBe(true);
    expect(readFileSync(join(project, "keep.txt"), "utf-8")).toBe("project-owned\n");

    expect(run(LIFECYCLE, [
      "update", "--version", AIDLC_VERSION, "--from", release,
    ], project, env).status).toBe(0);
    writeFileSync(join(machine, "default-harness"), "claude\n");
    expect(run(LIFECYCLE, ["uninstall", "--purge", "--yes"], project, env).status).toBe(0);
    for (
      const path of [
        "config.json",
        "update-check.json",
        "pins.json",
        "default-harness",
      ]
    ) {
      expect(existsSync(join(machine, path))).toBe(false);
    }
    expect(readFileSync(join(project, "keep.txt"), "utf-8")).toBe("project-owned\n");
  }, 60_000);
});

describe("t244 installer has no machine-level harness selection", () => {
  test("Unix and PowerShell installers reject the retired harness flag and never render a picker", () => {
    const unix = readFileSync(INSTALL_SH, "utf-8");
    const powershell = readFileSync(INSTALL_PS1, "utf-8");
    expect(unix).not.toContain("Select the harness distribution to install:");
    expect(unix).not.toContain("--harness <name>");
    expect(powershell).not.toContain("Select the harness distribution to install:");
    expect(powershell).not.toContain("[Alias('-harness')]");
    const result = spawnSync("sh", [INSTALL_SH, "--harness", "claude"], {
      cwd: REPO_ROOT, encoding: "utf-8", timeout: 10_000,
    });
    expect(result.status).toBe(2);
  });
});

describe("t244 Windows and completion release surfaces", () => {
  test("Windows uninstall cleanup supports adding completion metadata in PowerShell 5.1", () => {
    const source = readFileSync(
      join(REPO_ROOT, "core", "tools", "aidlc-windows-uninstall.ts"),
      "utf-8",
    );
    expect(source).toContain(
      "$journal | Add-Member -NotePropertyName completedAt",
    );
    expect(source).not.toContain("$journal.completedAt =");
    expect(source).toContain("Start-Process -FilePath 'powershell.exe'");
    expect(source).toContain("const launched = Bun.spawnSync");
  });

  test("install-profile usage names the invoking user's shell profile", () => {
    const result = run(
      DISPATCHER,
      ["system", "lifecycle", "install-profile"],
      REPO_ROOT,
    );
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).toContain(
      "install-profile writes the invoking user's shell profile",
    );
    expect(result.stdout + result.stderr).not.toContain("system PATH");
  });

  test("strict active pointer accepts one versioned executable and rejects extra lines", () => {
    const machine = temp("aidlc-t241-pointer-");
    const saved = process.env.AIDLC_INSTALL_ROOT;
    process.env.AIDLC_INSTALL_ROOT = machine;
    try {
      const executable = join(
        machine,
        "versions",
        "2.5.0",
        process.platform === "win32" ? "aidlc.exe" : "aidlc",
      );
      mkdirSync(join(machine, "versions", "2.5.0"), { recursive: true });
      writeFileSync(activeExecutablePath(), `${executable}\r\n`);
      expect(readActiveExecutable()).toBe(executable);
      writeFileSync(activeExecutablePath(), `${executable}\r\n${executable}\r\n`);
      expect(() => readActiveExecutable()).toThrow("exactly one executable path");
      writeFileSync(activeExecutablePath(), `${executable} \r\n`);
      expect(() => readActiveExecutable()).toThrow();
      writeFileSync(
        activeExecutablePath(),
        `${join(machine, "outside", process.platform === "win32" ? "aidlc.exe" : "aidlc")}\r\n`,
      );
      expect(() => readActiveExecutable()).toThrow();
    } finally {
      if (saved === undefined) delete process.env.AIDLC_INSTALL_ROOT;
      else process.env.AIDLC_INSTALL_ROOT = saved;
    }
  });

  test.skipIf(process.platform !== "win32")(
    "native Windows rollback flips the stable shim pointer and doctor accepts it",
    () => {
      const machine = temp("aidlc-t241-windows-rollback-");
      const source = join(machine, "version-fixture.ts");
      const output = join(machine, "version-fixture.exe");
      writeFileSync(
        source,
        [
          'import { basename, dirname } from "node:path";',
          'if (process.argv[2] === "version") {',
          '  process.stdout.write("aidlc " + basename(dirname(process.execPath)) + "\\n");',
          '  process.exit(0);',
          "}",
          'if (process.argv[2] === "probe") {',
          '  process.stdout.write(JSON.stringify(process.argv.slice(3)) + "\\n");',
          "  process.exit(23);",
          "}",
          "",
        ].join("\n"),
      );
      const build = spawnSync(
        process.execPath,
        ["build", "--compile", source, "--outfile", output],
        { encoding: "utf-8", timeout: 180_000 },
      );
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
      const executableFixture = existsSync(output) ? output : `${output}.exe`;
      expect(existsSync(executableFixture)).toBe(true);

      for (const version of ["1.0.0", "1.1.0"]) {
        const root = join(machine, "versions", version);
        const runtime = join(root, "runtime", "claude");
        mkdirSync(root, { recursive: true });
        cpSync(executableFixture, join(root, "aidlc.exe"));
        cpSync(join(REPO_ROOT, "dist-release", "claude"), runtime, {
          recursive: true,
        });
        const stampPath = join(
          runtime,
          ".claude",
          "tools",
          "data",
          "aidlc-stamp.json",
        );
        const stamp = JSON.parse(readFileSync(stampPath, "utf-8")) as {
          frameworkVersion: string;
        };
        writeFileSync(
          stampPath,
          `${JSON.stringify({ ...stamp, frameworkVersion: version }, null, 2)}\n`,
        );
        const executable = join(root, "aidlc.exe");
        writeFileSync(
          join(root, "version.json"),
          `${JSON.stringify({
            schemaVersion: 1,
            version,
            date: "2026-07-18",
            distributions: [{ name: "claude", productName: "Claude Code" }],
            assets: [{
              name: "aidlc-windows-x64.exe",
              sha256: createHash("sha256")
                .update(readFileSync(executable))
                .digest("hex"),
              bytes: statSync(executable).size,
              kind: "binary",
              target: "windows-x64",
            }],
          }, null, 2)}\n`,
        );
      }

      const saved = {
        root: process.env.AIDLC_INSTALL_ROOT,
        bin: process.env.AIDLC_BIN_DIR,
      };
      process.env.AIDLC_INSTALL_ROOT = machine;
      process.env.AIDLC_BIN_DIR = join(machine, "bin");
      try {
        activate("1.0.0");
        const forwarded = spawnSync(
          "cmd.exe",
          [
            "/d",
            "/s",
            "/c",
            `""${commandPath()}" probe "value with spaces" plain"`,
          ],
          { encoding: "utf-8", timeout: 60_000 },
        );
        expect(forwarded.status, forwarded.stderr ?? "").toBe(23);
        expect(JSON.parse((forwarded.stdout ?? "").trim())).toEqual([
          "value with spaces",
          "plain",
        ]);
        writeFileSync(activeExecutablePath(), "C:\\outside\\aidlc.exe\r\n");
        activate("1.1.0");
        const rollback = run(
          LIFECYCLE,
          ["rollback"],
          REPO_ROOT,
          envFor(machine),
        );
        expect(rollback.status, rollback.stdout + rollback.stderr).toBe(0);
        expect(readActiveExecutable()).toBe(
          join(machine, "versions", "1.0.0", "aidlc.exe"),
        );
        const doctor = run(
          DISPATCHER,
          ["doctor", "--json", "--project-dir", REPO_ROOT],
          REPO_ROOT,
          envFor(machine),
        );
        const report = JSON.parse(doctor.stdout) as {
          data: { checks: Array<{ pass: boolean; label: string }> };
        };
        expect(report.data.checks).toContainEqual(
          expect.objectContaining({
            pass: true,
            label: expect.stringContaining("Command pointer:"),
          }),
        );
      } finally {
        if (saved.root === undefined) delete process.env.AIDLC_INSTALL_ROOT;
        else process.env.AIDLC_INSTALL_ROOT = saved.root;
        if (saved.bin === undefined) delete process.env.AIDLC_BIN_DIR;
        else process.env.AIDLC_BIN_DIR = saved.bin;
      }
    },
    240_000,
  );

  test("malformed Windows uninstall journals are reported", () => {
    const malformed = join(tmpdir(), `aidlc-uninstall-${randomUUID()}.json`);
    const missingRoot = join(tmpdir(), `aidlc-uninstall-${randomUUID()}.json`);
    try {
      writeFileSync(malformed, "{not-json\n");
      writeFileSync(missingRoot, `${JSON.stringify({
        schemaVersion: 1,
        operation: "windows-uninstall-continuation",
      })}\n`);
      const scan = scanWindowsUninstallJournals();
      expect(scan.invalid).toContain(malformed);
      expect(scan.invalid).toContain(missingRoot);
    } finally {
      rmSync(malformed, { force: true });
      rmSync(missingRoot, { force: true });
    }
  });

  test("orphan Windows uninstall fences are reported as invalid recovery state", () => {
    const machine = temp("aidlc-t240-uninstall-orphan-fence-");
    const saved = {
      root: process.env.AIDLC_INSTALL_ROOT,
      bin: process.env.AIDLC_BIN_DIR,
    };
    process.env.AIDLC_INSTALL_ROOT = machine;
    process.env.AIDLC_BIN_DIR = join(machine, "bin");
    try {
      const fence = windowsUninstallFencePath();
      writeFileSync(fence, "{}\n");
      expect(scanWindowsUninstallJournals().invalid).toContain(fence);
    } finally {
      if (saved.root === undefined) delete process.env.AIDLC_INSTALL_ROOT;
      else process.env.AIDLC_INSTALL_ROOT = saved.root;
      if (saved.bin === undefined) delete process.env.AIDLC_BIN_DIR;
      else process.env.AIDLC_BIN_DIR = saved.bin;
    }
  });

  test("installer completion generation remains under system while the public verb is absent", () => {
    for (const shell of ["bash", "zsh", "fish", "powershell"]) {
      const first = run(DISPATCHER, ["system", "completions", shell], REPO_ROOT);
      const second = run(DISPATCHER, ["system", "completions", shell], REPO_ROOT);
      expect(first.status, first.stdout + first.stderr).toBe(0);
      expect(first.stdout).toBe(second.stdout);
      for (const command of ["config", "doctor", "update", "use", "version", "uninstall"]) {
        expect(first.stdout).toContain(command);
      }
      for (const retired of ["rollback", "versions", "harness", "package", "plugin", "completions"]) {
        expect(first.stdout).not.toContain(` ${retired}`);
      }
      expect(first.stdout).toContain(
        shell === "fish" ? "check-updates" : "--check-updates",
      );
    }
    const powershell = run(
      DISPATCHER,
      ["system", "completions", "powershell"],
      REPO_ROOT,
    );
    expect(powershell.stdout).not.toContain("-AsHashtable");
    const bash = run(DISPATCHER, ["system", "completions", "bash"], REPO_ROOT);
    const syntax = spawnSync("bash", ["-n"], {
      input: bash.stdout,
      encoding: "utf-8",
    });
    expect(syntax.status, syntax.stderr).toBe(0);
    const zsh = run(DISPATCHER, ["system", "completions", "zsh"], REPO_ROOT);
    const zshSyntax = spawnSync("zsh", ["-n"], {
      input: zsh.stdout,
      encoding: "utf-8",
    });
    expect(zshSyntax.status, zshSyntax.stderr).toBe(0);
    expect(run(DISPATCHER, ["completions", "bash"], REPO_ROOT).status).toBe(2);
  });

  test("PowerShell installer is authenticated release content and delegates placement", () => {
    const script = readFileSync(INSTALL_PS1, "utf-8");
    expect(script).toContain("aidlc-windows-x64.exe");
    expect(script).toContain("'install-apply'");
    expect(script).toContain("Get-FileHash -Algorithm SHA256");
    expect(script).toContain("Unblock-File");
    expect(script).toContain("$env:AIDLC_OFFLINE");
    expect(script).toContain("$verifiedInstaller");
    expect(script).toContain("$releaseUri.Query");
    expect(script).toContain("$releaseUri.Fragment");
    expect(script).toContain("installer validation failed:");
    expect(script).toContain("$env:Path = \"$binDir;$env:Path\"");
    expect(script).toContain("exceeds the 1 MiB metadata limit");
    const release = fixture();
    const manifest = JSON.parse(readFileSync(join(release, "version.json"), "utf-8")) as {
      assets: Array<{ name: string; kind: string }>;
    };
    expect(manifest.assets).toContainEqual(
      expect.objectContaining({ name: "install.ps1", kind: "installer" }),
    );
  });

  test("release workflow lints installers and publishes the tested candidate", () => {
    const workflow = readFileSync(
      join(REPO_ROOT, ".github", "workflows", "release.yml"),
      "utf-8",
    );
    const parsed = Bun.YAML.parse(workflow) as {
      permissions?: Record<string, string>;
      jobs?: Record<string, { permissions?: Record<string, string> }>;
    };
    expect(parsed.permissions).toEqual({ contents: "read" });
    expect(parsed.jobs?.publish?.permissions).toEqual({
      contents: "write",
      "id-token": "write",
      attestations: "write",
    });
    const actionRefs = [...workflow.matchAll(
      /^\s*(?:-\s+)?uses:\s+([^\s#]+)(?:\s+#.*)?$/gm,
    )].map((match) => match[1]);
    expect(actionRefs.length).toBeGreaterThan(0);
    for (const ref of actionRefs) {
      expect(ref).toMatch(/^[^@\s]+@[a-f0-9]{40}$/);
    }
    expect(workflow).not.toMatch(/^\s*(?:-\s+)?uses:\s+[^@\s]+@v\d/m);
    expect(workflow).toContain("shellcheck scripts/install.sh");
    expect(workflow).toContain("Invoke-ScriptAnalyzer -Path scripts/install.ps1");
    expect(workflow).toContain("unix-lifecycle:");
    expect(workflow).not.toContain("interactive harness picker");
    expect(workflow).toContain("install.ps1 -ReleaseBaseUrl");
    expect(workflow).not.toMatch(/install\.(?:sh|ps1)[^\n]*--harness/);
    expect(workflow).not.toMatch(/install\.ps1[^\n]*-Harness/);
    expect(workflow).toContain("name: release-candidate");
    expect(workflow).toContain(`build-results-\${{ matrix.directory }}.json`);
    const publish = workflow.slice(workflow.indexOf("  publish:"));
    expect(publish).toContain("name: release-candidate");
    expect(publish).toContain("sha256sum -c checksums.txt");
    expect(publish.indexOf("sha256sum -c checksums.txt"))
      .toBeLessThan(publish.indexOf("name: Attest staged release assets"));
    expect(publish.indexOf("name: Attest staged release assets"))
      .toBeLessThan(publish.indexOf("name: Stage offline provenance bundle"));
    expect(publish.indexOf("name: Stage offline provenance bundle"))
      .toBeLessThan(publish.indexOf("gh release create"));
    expect(publish).toContain("steps.provenance.outputs.bundle-path");
    expect(publish).toContain("build/release/aidlc-release.intoto.jsonl");
    expect(publish).not.toContain("scripts/package-release.ts");
    expect(publish).not.toContain("pattern: binary-*");
  });
});
