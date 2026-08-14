#!/usr/bin/env bun
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { extractTarGz } from "./aidlc-archive.ts";
import {
  renderCompletion,
  type Shell,
} from "./aidlc-completions.ts";
import {
  EXIT,
  type CommandResult,
  emitResult,
  failure,
  globalOptions,
  success,
  usage,
  valueAfter,
} from "./aidlc-command.ts";
import {
  projectionFiles,
  sha256File,
  walkFiles,
} from "./aidlc-distribution.ts";
import {
  activeVersion,
  activeExecutablePath,
  activeVersionPath,
  commandPath,
  installedExecutablePath,
  inspectInstalledVersion,
  installRoot,
  machineTransactionRoot,
  packageManagerForExecutable,
  projectDirFrom,
  requireVersion,
  readActiveExecutable,
  rollbackVersionPath,
  runtimeRoot,
  targetTriple,
  versionRoot,
  versionsRoot,
} from "./aidlc-install-paths.ts";
import {
  defaultHarnessPath,
  machineConfigPath,
  updateCachePath,
} from "./aidlc-machine-config.ts";
import {
  acquireRelease,
  digest,
  ReleaseUnavailableError,
} from "./aidlc-release.ts";
import {
  executePlan,
  transactionSourceHash,
  transactionState,
  writeOperation,
} from "./aidlc-transaction.ts";
import { refreshUpdateState } from "./aidlc-update.ts";
import {
  recoverWindowsUninstallContinuations,
  scheduleWindowsUninstall as scheduleWindowsUninstallContinuation,
} from "./aidlc-windows-uninstall.ts";
import {
  discoverProjectHarnesses,
  runtimeHarnessDir,
} from "./aidlc-runtime-paths.ts";

class LifecycleCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "LifecycleCommandError";
  }
}

function commandError(message: string, exitCode: number): never {
  throw new LifecycleCommandError(message, exitCode);
}

function requestedVersion(value: string): string {
  try {
    return requireVersion(value);
  } catch (error) {
    return commandError(
      error instanceof Error ? error.message : String(error),
      EXIT.usage,
    );
  }
}

function offline(argv: readonly string[]): boolean | undefined {
  if (argv.includes("--offline") || process.env.AIDLC_OFFLINE === "1") return true;
  if (process.env.AIDLC_OFFLINE === "0") return false;
  return undefined;
}

const RUNTIME_ASSET = "aidlc-runtime.tar.gz";
const COMPLETION_FILES: Readonly<Record<Shell, string>> = {
  bash: "aidlc.bash",
  zsh: "_aidlc",
  fish: "aidlc.fish",
  powershell: "aidlc.ps1",
};

function binaryAsset(target = targetTriple()): string {
  return `aidlc-${target}${target.startsWith("windows-") ? ".exe" : ""}`;
}

function installedDistributions(version: string): string[] {
  const root = runtimeRoot(version);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((entry) => {
    try {
      projectionFiles(join(root, entry));
      return true;
    } catch {
      return false;
    }
  }).sort();
}

function completeVersion(version: string): boolean {
  try {
    return inspectInstalledVersion(version).complete;
  } catch {
    return false;
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function requireConfirmation(argv: readonly string[], message: string): void {
  if (argv.includes("--yes")) return;
  if (!process.stdin.isTTY) {
    commandError(`${message}; non-interactive use requires --yes`, EXIT.usage);
  }
  const answer = prompt(`${message}\nContinue [y/N]:`);
  if (!/^y(?:es)?$/i.test(answer?.trim() ?? "")) {
    commandError("operation cancelled", EXIT.failure);
  }
}

function windowsLauncherOwnedByInstaller(): boolean {
  try {
    return readFileSync(commandPath(), "utf-8") === windowsShim() &&
      readFileSync(windowsShimPath(), "utf-8") === windowsShimHelper();
  } catch {
    return false;
  }
}

function commandOwnedByInstaller(version: string): boolean {
  try {
    if (process.platform === "win32") {
      return windowsLauncherOwnedByInstaller() &&
        readActiveExecutable() === resolve(installedExecutablePath(version));
    }
    return lstatSync(commandPath()).isSymbolicLink() &&
      realpathSync(commandPath()) === realpathSync(installedExecutablePath(version));
  } catch {
    return false;
  }
}

function readPinRegistry(strict = false): {
  pins: Record<string, string>;
  warnings: string[];
} {
  const path = join(installRoot(), "pins.json");
  if (!existsSync(path)) return { pins: {}, warnings: [] };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    const warning = `${path} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
    if (strict) commandError(warning, EXIT.integrity);
    return { pins: {}, warnings: [warning] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const warning = `${path} must contain a project-to-version object`;
    if (strict) commandError(warning, EXIT.integrity);
    return { pins: {}, warnings: [warning] };
  }
  const pins: Record<string, string> = {};
  const warnings: string[] = [];
  for (const [project, version] of Object.entries(value as Record<string, unknown>)) {
    if (!isAbsolute(project) || typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
      warnings.push(`${path} contains an invalid pin entry for ${project}`);
      continue;
    }
    pins[project] = version;
  }
  if (strict && warnings.length > 0) commandError(warnings.join("; "), EXIT.integrity);
  return { pins, warnings };
}

function registeredPins(strict = false): {
  pins: Record<string, string>;
  warnings: string[];
} {
  const { pins: rawPins, warnings } = readPinRegistry(strict);
  const pins: Record<string, string> = {};
  for (const [project, version] of Object.entries(rawPins)) {
    if (existsSync(project)) {
      try {
        const pinPath = join(project, ".aidlc-version");
        if (
          !existsSync(pinPath) ||
          !statSync(pinPath).isFile() ||
          readFileSync(pinPath, "utf-8").trim() !== version
        ) {
          continue;
        }
      } catch {
        continue;
      }
    }
    pins[project] = version;
  }
  return { pins, warnings };
}

function commitProjectPin(projectDir: string, version: string | null): void {
  const project = existsSync(projectDir) ? realpathSync(projectDir) : resolve(projectDir);
  const pinPath = join(projectDir, ".aidlc-version");
  const registryPath = join(installRoot(), "pins.json");
  const pins = readPinRegistry(true).pins;
  if (version === null) delete pins[project];
  else pins[project] = version;

  const projectOperations = version === null
    ? existsSync(pinPath)
      ? [{
          kind: "remove" as const,
          path: ".aidlc-version",
          expected: transactionState(pinPath) as string,
        }]
      : []
    : [writeOperation(
        ".aidlc-version",
        `${version}\n`,
        transactionState(pinPath),
      )];

  const root = machineTransactionRoot();
  executePlan({
    schemaVersion: 1,
    root,
    operations: [writeOperation(
      relative(root, registryPath),
      `${JSON.stringify(pins, null, 2)}\n`,
      transactionState(registryPath),
      0o600,
    )],
  }, {
    validateCommitted: () => {
      if (projectOperations.length === 0) return;
      executePlan({
        schemaVersion: 1,
        root: projectDir,
        operations: projectOperations,
      });
    },
  });
}

function lifecycleFailureResult(error: unknown, argv: readonly string[]): CommandResult {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof LifecycleCommandError
    ? error.exitCode
    : error instanceof ReleaseUnavailableError
    ? EXIT.unavailable
    : valueAfter(argv, "--from") &&
        /(checksum|version\.json|checksums\.txt|release is missing|invalid asset|size mismatch)/i
          .test(message)
    ? EXIT.integrity
    : EXIT.failure;
  return failure(message, code);
}

function treesMatch(left: string, right: string): boolean {
  const leftFiles = walkFiles(left).map((path) => path.replaceAll("\\", "/"));
  const rightFiles = walkFiles(right).map((path) => path.replaceAll("\\", "/"));
  if (JSON.stringify(leftFiles) !== JSON.stringify(rightFiles)) return false;
  return leftFiles.every((path) =>
    sha256File(join(left, path)) === sha256File(join(right, path)) &&
    (statSync(join(left, path)).mode & 0o777) === (statSync(join(right, path)).mode & 0o777)
  );
}

function retainedVersions(): {
  versions: Array<{
    version: string;
    active: boolean;
    rollback: boolean;
    distributions: string[];
    complete: boolean;
    pinPaths: string[];
    stalePinPaths: string[];
  }>;
  pinWarnings: string[];
} {
  const { pins, warnings } = registeredPins();
  if (!existsSync(versionsRoot())) return { versions: [], pinWarnings: warnings };
  const active = activeVersion();
  const rollback = existsSync(rollbackVersionPath())
    ? readFileSync(rollbackVersionPath(), "utf-8").trim()
    : null;
  const versions = readdirSync(versionsRoot()).filter((entry) => /^\d+\.\d+\.\d+$/.test(entry)).sort()
    .map((version) => ({
      version,
      active: version === active,
      rollback: version === rollback,
      distributions: installedDistributions(version),
      complete: completeVersion(version),
      pinPaths: Object.entries(pins)
        .filter(([project, pinnedVersion]) => pinnedVersion === version && existsSync(project))
        .map(([project]) => project)
        .sort(),
      stalePinPaths: Object.entries(pins)
        .filter(([project, pinnedVersion]) => pinnedVersion === version && !existsSync(project))
        .map(([project]) => project)
        .sort(),
    }));
  return { versions, pinWarnings: warnings };
}

function assertVersionsRemainPrunable(versions: readonly string[]): void {
  const refreshed = retainedVersions();
  if (refreshed.pinWarnings.length > 0) {
    commandError(
      `prune cancelled because pin registry changed: ${refreshed.pinWarnings.join("; ")}`,
      EXIT.integrity,
    );
  }
  const current = new Map(refreshed.versions.map((item) => [item.version, item]));
  const protectedVersions = versions.filter((version) => {
    const item = current.get(version);
    return !item ||
      item.active ||
      item.rollback ||
      item.pinPaths.length > 0 ||
      item.stalePinPaths.length > 0;
  });
  if (protectedVersions.length > 0) {
    commandError(
      `prune cancelled because version protection changed: ${protectedVersions.join(", ")}`,
      EXIT.failure,
    );
  }
}

function projectDistribution(projectDir: string): string | null {
  const harnessDir = runtimeHarnessDir(projectDir);
  return discoverProjectHarnesses(projectDir)
    .find((candidate) => candidate.harnessDir === harnessDir)?.distribution ?? null;
}

export function activate(version: string, options: { failAfter?: number } = {}): void {
  if (!completeVersion(version)) {
    commandError(`retained version ${version} is incomplete`, EXIT.unavailable);
  }
  const previous = activeVersion();
  const root = machineTransactionRoot();
  const target = installedExecutablePath(version);
  const windows = process.platform === "win32";
  const shim = windows ? windowsShim() : null;
  const shimHelper = windows ? windowsShimHelper() : null;
  if (
    pathEntryExists(commandPath()) &&
    (!previous ||
      !(windows
        ? windowsLauncherOwnedByInstaller()
        : commandOwnedByInstaller(previous)))
  ) {
    commandError(
      `existing ${commandPath()} is not owned by this AI-DLC install`,
      EXIT.integrity,
    );
  }
  if (windows && existsSync(commandPath()) && readFileSync(commandPath(), "utf-8") !== shim) {
    commandError("existing aidlc.cmd is not owned by this AI-DLC install", EXIT.integrity);
  }
  if (
    windows &&
    existsSync(windowsShimPath()) &&
    readFileSync(windowsShimPath(), "utf-8") !== shimHelper
  ) {
    commandError("existing aidlc-shim.ps1 is not owned by this AI-DLC install", EXIT.integrity);
  }
  const operations = [
    ...(previous && previous !== version
      ? [writeOperation(relative(root, rollbackVersionPath()), `${previous}\n`,
          transactionState(rollbackVersionPath()))]
      : []),
    writeOperation(
      relative(root, activeVersionPath()),
      `${version}\n`,
      transactionState(activeVersionPath()),
    ),
    ...(windows
      ? [
          ...(!existsSync(windowsShimPath())
            ? [writeOperation(
                relative(root, windowsShimPath()),
                shimHelper as string,
                "absent",
                0o700,
              )]
            : []),
          ...(!existsSync(commandPath())
            ? [writeOperation(
                relative(root, commandPath()),
                shim as string,
                "absent",
                0o700,
              )]
            : []),
          writeOperation(
            relative(root, activeExecutablePath()),
            `${target}\r\n`,
            transactionState(activeExecutablePath()),
            0o600,
          ),
        ]
      : [{
          kind: "symlink" as const,
          path: relative(root, commandPath()),
          target,
          expected: transactionState(commandPath()),
        }]),
    ...(Object.entries(COMPLETION_FILES) as Array<[Shell, string]>)
      .map(([shell, file]) => {
        const path = join(installRoot(), "completions", file);
        return writeOperation(
          relative(root, path),
          renderCompletion(shell),
          transactionState(path),
          0o644,
        );
      }),
  ];
  executePlan({
    schemaVersion: 1,
    root,
    operations,
  }, {
    ...options,
    validateCommitted: () => {
      if (
        windows
          ? readActiveExecutable() !== resolve(target)
          : realpathSync(commandPath()) !== realpathSync(target)
      ) {
        throw new Error(`command pointer validation failed for ${version}`);
      }
      const probe = Bun.spawnSync([commandPath(), "version"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = Buffer.from(probe.stdout ?? new Uint8Array()).toString("utf-8").trim();
      if (probe.exitCode !== 0 || output !== `aidlc ${version} (runtime ${version})`) {
        throw new Error(
          `command pointer validation failed for ${version}: version probe returned ${
            probe.exitCode ?? "no exit"
          } ${JSON.stringify(output)}`,
        );
      }
    },
  });
}

function windowsShim(): string {
  const helper = windowsShimPath().replaceAll("%", "%%");
  return [
    "@echo off",
    `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${helper}" %*`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}

function windowsShimPath(): string {
  return join(installRoot(), "aidlc-shim.ps1");
}

function windowsShimHelper(): string {
  const pointer = activeExecutablePath().replaceAll("'", "''");
  const root = versionsRoot().replaceAll("'", "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$pointer = '${pointer}'`,
    `$versions = [IO.Path]::GetFullPath('${root}')`,
    "try {",
    "  $raw = [IO.File]::ReadAllText($pointer)",
    "  if ($raw -notmatch '^[^\\r\\n]+\\r?\\n?$') { exit 4 }",
    "  $executable = [IO.Path]::GetFullPath($raw.TrimEnd(\"`r\", \"`n\"))",
    "  $prefix = $versions.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar",
    "  if (-not $executable.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { exit 4 }",
    "  $relative = $executable.Substring($prefix.Length)",
    "  if ($relative -notmatch '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\\\aidlc\\.exe$') { exit 4 }",
    "  if (-not [IO.File]::Exists($executable)) { exit 4 }",
    "  $env:AIDLC_SHIM_PID = [string]$PID",
    "  & $executable @args",
    "  exit $LASTEXITCODE",
    "} catch {",
    "  exit 4",
    "}",
    "",
  ].join("\r\n");
}

async function installVersion(options: {
  version?: string;
  from?: string;
  offline?: boolean;
  activate: boolean;
  dryRun: boolean;
  baseUrl?: string;
  caBundle?: string;
}): Promise<{ version: string; distributions: string[] }> {
  const wantedVersion = options.version ? requestedVersion(options.version) : undefined;
  const target = targetTriple();
  const required = [binaryAsset(target), RUNTIME_ASSET];
  const release = await acquireRelease({
    version: wantedVersion,
    from: options.from,
    names: required,
    offline: options.offline,
    baseUrl: options.baseUrl,
    caBundle: options.caBundle,
  });
  const version = release.manifest.version;
  const temporary = mkdtempSync(join(tmpdir(), `aidlc-version-${version}-`));
  try {
    const candidate = join(temporary, version);
    mkdirSync(join(candidate, "runtime"), { recursive: true });
    const binarySource = join(release.directory, binaryAsset(target));
    const candidateExecutable = join(
      candidate,
      process.platform === "win32" ? "aidlc.exe" : "aidlc",
    );
    writeFileSync(candidateExecutable, readFileSync(binarySource), { mode: 0o755 });
    if (process.platform !== "win32") chmodSync(candidateExecutable, 0o755);
    extractTarGz(join(release.directory, RUNTIME_ASSET), candidate, {
      reservedTopLevelNames: ["aidlc", "aidlc.exe"],
    });
    const distributions = release.manifest.distributions.map((item) => item.name).sort();
    for (const distribution of distributions) {
      const root = join(candidate, "runtime", distribution);
      const { stamp } = projectionFiles(root);
      if (stamp.frameworkVersion !== version || stamp.distribution !== distribution) {
        throw new Error(`${distribution} runtime stamp does not match release ${version}`);
      }
    }
    writeFileSync(
      join(candidate, "version.json"),
      `${JSON.stringify(release.manifest, null, 2)}\n`,
    );
    if (!options.dryRun) {
      const destination = versionRoot(version);
      if (existsSync(destination)) {
        const priorManifestPath = join(destination, "version.json");
        if (!existsSync(priorManifestPath)) {
          commandError(`existing ${version} install has no release manifest`, EXIT.integrity);
        }
        const priorManifest = JSON.parse(readFileSync(priorManifestPath, "utf-8")) as {
          assets?: Array<{ name: string; sha256: string }>;
        };
        const expectedAssets = new Map(
          release.manifest.assets.map((asset) => [asset.name, asset.sha256]),
        );
        for (const assetName of required) {
          const prior = priorManifest.assets?.find((asset) => asset.name === assetName);
          if (!prior || prior.sha256 !== expectedAssets.get(assetName)) {
            commandError(
              `existing ${version} install came from a different ${assetName}`,
              EXIT.integrity,
            );
          }
        }
        if (digest(installedExecutablePath(version)) !== expectedAssets.get(binaryAsset(target))) {
          commandError(
            `existing ${version} binary does not match the verified release`,
            EXIT.integrity,
          );
        }
        if (!treesMatch(join(destination, "runtime"), join(candidate, "runtime"))) {
          commandError(
            `existing ${version} runtime does not match the verified release`,
            EXIT.integrity,
          );
        }
        if (!completeVersion(version)) {
          commandError(`existing ${version} install is incomplete`, EXIT.integrity);
        }
      } else {
        executePlan({
          schemaVersion: 1,
          root: machineTransactionRoot(),
          operations: [{
            kind: "tree",
            path: relative(machineTransactionRoot(), destination),
            source: candidate,
            sourceHash: transactionSourceHash(candidate),
            expected: "absent",
          }],
        });
      }
      if (options.activate) activate(version);
    }
    return { version, distributions };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    if (release.cleanup) rmSync(release.cleanup, { recursive: true, force: true });
  }
}

async function versionsCommand(argv: string[]): Promise<ReturnType<typeof success>> {
  const verb = argv[1];
  if (verb === "list") {
    const { versions, pinWarnings } = retainedVersions();
    if (argv.includes("--completion-values")) {
      return success(
        versions.filter((item) => item.complete).map((item) => item.version).join("\n"),
      );
    }
    return success(
      (versions.length
        ? versions.map((item) =>
            `${item.version}${item.active ? " active" : ""}${item.rollback ? " rollback" : ""} [${item.distributions.join(",")}] pins=${item.pinPaths.length} stale-pins=${item.stalePinPaths.length}${item.complete ? "" : " incomplete"}`
          ).join("\n")
        : "no retained versions") +
        (pinWarnings.length > 0 ? `\nwarning: ${pinWarnings.join("; ")}` : ""),
      { versions, pinWarnings },
    );
  }
  if (verb === "prune") {
    const { versions, pinWarnings } = retainedVersions();
    if (pinWarnings.length > 0) {
      commandError(
        `cannot prune while pin registry is invalid: ${pinWarnings.join("; ")}`,
        EXIT.integrity,
      );
    }
    const protectedVersions = versions.filter((item) =>
      item.active ||
      item.rollback ||
      item.pinPaths.length > 0 ||
      item.stalePinPaths.length > 0
    );
    const removable = versions.filter((item) => !protectedVersions.includes(item));
    const protection = protectedVersions.map((item) => {
      const reasons = [
        ...(item.active ? ["active"] : []),
        ...(item.rollback ? ["rollback"] : []),
        ...item.pinPaths.map((path) => `pinned by ${path}`),
        ...item.stalePinPaths.map((path) => `stale pin ${path}`),
      ];
      return `${item.version} (${reasons.join(", ")})`;
    }).join("; ");
    if (removable.length === 0) {
      return success(
        protection
          ? `no versions eligible for pruning; protected: ${protection}`
          : "no versions eligible for pruning",
        { removed: [], protected: protectedVersions },
      );
    }
    requireConfirmation(
      argv,
      `Prune retained versions ${removable.map((item) => item.version).join(", ")}?`,
    );
    const refreshed = retainedVersions();
    if (refreshed.pinWarnings.length > 0) {
      commandError(
        `prune cancelled because pin registry changed: ${refreshed.pinWarnings.join("; ")}`,
        EXIT.failure,
      );
    }
    const refreshedByVersion = new Map(
      refreshed.versions.map((item) => [item.version, item]),
    );
    const newlyProtected = removable.filter((item) => {
      const current = refreshedByVersion.get(item.version);
      return !current ||
        current.active ||
        current.rollback ||
        current.pinPaths.length > 0 ||
        current.stalePinPaths.length > 0;
    });
    if (newlyProtected.length > 0) {
      commandError(
        `prune cancelled because version protection changed: ${
          newlyProtected.map((item) => item.version).join(", ")
        }`,
        EXIT.failure,
      );
    }
    const root = machineTransactionRoot();
    executePlan({
      schemaVersion: 1,
      root,
      operations: removable.map((item) => ({
        kind: "remove" as const,
        path: relative(root, versionRoot(item.version)),
        expected: transactionState(versionRoot(item.version)) as string,
      })),
    }, {
      validateLocked: () =>
        assertVersionsRemainPrunable(removable.map((item) => item.version)),
    });
    return success(
      `pruned ${removable.map((item) => item.version).join(", ")}${
        protection ? `; protected: ${protection}` : ""
      }`,
      { removed: removable.map((item) => item.version), protected: protectedVersions },
    );
  }
  if (verb !== "install") return usage("usage: aidlc system versions <list|install|prune>");
  const version = argv[2];
  if (!version || version.startsWith("--")) return usage("versions install requires a strict version");
  if (argv.includes("--harness")) return usage("unknown argument: --harness");
  const result = await installVersion({
    version,
    from: valueAfter(argv, "--from"),
    offline: offline(argv),
    activate: false,
    dryRun: argv.includes("--dry-run"),
    baseUrl: valueAfter(argv, "--release-base-url"),
    caBundle: valueAfter(argv, "--ca-bundle"),
  });
  return success(
    `installed ${result.version} side-by-side; active version remains ${activeVersion() ?? "unchanged"}`,
    result,
  );
}

function pruneUnprotectedVersions(): string[] {
  const { versions, pinWarnings } = retainedVersions();
  if (pinWarnings.length > 0) {
    commandError(
      `cannot prune while pin registry is invalid: ${pinWarnings.join("; ")}`,
      EXIT.integrity,
    );
  }
  const removable = versions.filter((item) =>
    !item.active &&
    !item.rollback &&
    item.pinPaths.length === 0 &&
    item.stalePinPaths.length === 0
  );
  if (removable.length === 0) return [];
  const root = machineTransactionRoot();
  executePlan({
    schemaVersion: 1,
    root,
    operations: removable.map((item) => ({
      kind: "remove" as const,
      path: relative(root, versionRoot(item.version)),
      expected: transactionState(versionRoot(item.version)) as string,
    })),
  }, {
    validateLocked: () =>
      assertVersionsRemainPrunable(removable.map((item) => item.version)),
  });
  return removable.map((item) => item.version);
}

function uninstallCommand(argv: string[]): CommandResult {
  const manager = packageManagerForExecutable(process.execPath);
  if (manager) {
    return failure(
      `AI-DLC is installed via ${manager.name}; self-uninstall is disabled`,
      EXIT.integrity,
      manager.remediation,
    );
  }
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return failure("refusing to uninstall a root-owned installation", EXIT.integrity);
  }
  if (process.platform === "win32") {
    const recovered = recoverWindowsUninstallContinuations();
    if (recovered > 0) {
      return success(
        `resumed ${recovered} pending Windows uninstall continuation(s)`,
        { purge: argv.includes("--purge"), deferred: true, recovered },
      );
    }
  }
  const version = activeVersion();
  if (!version || !completeVersion(version)) {
    return failure(
      "no complete native AI-DLC installation is active",
      EXIT.unavailable,
    );
  }
  if (!commandOwnedByInstaller(version)) {
    return failure(
      `existing ${commandPath()} is not owned by this AI-DLC install`,
      EXIT.integrity,
    );
  }
  const purge = argv.includes("--purge");
  const { versions } = retainedVersions();
  const preserved = purge ? "nothing" : "global config, update cache, pins, and harness default";
  requireConfirmation(
    argv,
    `Uninstall AI-DLC (${versions.length} retained version(s))? Project trees will not be changed; preserving ${preserved}.`,
  );
  if (process.platform === "win32") {
    return scheduleWindowsUninstall(purge);
  }
  const root = machineTransactionRoot();
  const paths = [
    commandPath(),
    versionsRoot(),
    activeVersionPath(),
    rollbackVersionPath(),
    activeExecutablePath(),
    ...(purge
      ? [
          machineConfigPath(),
          updateCachePath(),
          join(installRoot(), "pins.json"),
          defaultHarnessPath(),
        ]
      : []),
  ].filter(existsSync);
  executePlan({
    schemaVersion: 1,
    root,
    operations: paths.map((path) => ({
      kind: "remove" as const,
      path: relative(root, path),
      expected: transactionState(path) as string,
    })),
  });
  return success(
    `uninstalled AI-DLC; ${purge ? "removed machine configuration and cache" : "preserved machine configuration and cache"}`,
    { purge, preserved: purge ? [] : ["config", "update-cache", "pins", "default-harness"] },
  );
}

function scheduleWindowsUninstall(purge: boolean): CommandResult {
  const recovered = recoverWindowsUninstallContinuations();
  if (recovered > 0) {
    return success(
      `resumed ${recovered} pending Windows uninstall continuation(s)`,
      { purge, deferred: true, recovered },
    );
  }
  const preserved = [
    machineConfigPath(),
    updateCachePath(),
    join(installRoot(), "pins.json"),
    defaultHarnessPath(),
  ];
  scheduleWindowsUninstallContinuation(purge, preserved);
  return success(
    `uninstall scheduled; Windows cleanup will finish after this command exits`,
    { purge, deferred: true },
  );
}

async function updateCommand(argv: string[]): Promise<CommandResult> {
  const manager = packageManagerForExecutable(process.execPath);
  if (manager) {
    return failure(
      `AI-DLC is installed via ${manager.name}; self-update is disabled`,
      EXIT.failure,
      manager.remediation,
    );
  }
  const current = activeVersion();
  if (argv.includes("--harness")) return usage("unknown argument: --harness");
  if (argv.includes("--check")) {
    let state: Awaited<ReturnType<typeof refreshUpdateState>>;
    try {
      state = await refreshUpdateState(15_000, {
        offline: offline(argv),
        baseUrl: valueAfter(argv, "--release-base-url"),
        caBundle: valueAfter(argv, "--ca-bundle"),
      });
    } catch (error) {
      commandError(
        error instanceof Error ? error.message : String(error),
        error instanceof ReleaseUnavailableError ? EXIT.unavailable : EXIT.failure,
      );
    }
    if (state.state === "behind") {
      return {
        ...success(state.message, state),
        code: EXIT.actionNeeded,
        status: "action-needed",
      };
    }
    if (state.state === "invalid-config") {
      return failure(state.message, EXIT.usage, "repair or remove the invalid machine config");
    }
    if (
      state.state === "unavailable" ||
      state.state === "offline"
    ) {
      return failure(state.message, EXIT.unavailable);
    }
    if (state.state === "disabled") {
      return failure(state.message, EXIT.failure);
    }
    return success(state.message, state);
  }
  const dryRun = argv.includes("--dry-run");
  const result = await installVersion({
    version: valueAfter(argv, "--version"),
    from: valueAfter(argv, "--from"),
    offline: offline(argv),
    activate: true,
    dryRun,
    baseUrl: valueAfter(argv, "--release-base-url"),
    caBundle: valueAfter(argv, "--ca-bundle"),
  });
  const pruned = dryRun ? [] : pruneUnprotectedVersions();
  return success(
    dryRun
      ? `update plan: ${current ?? "none"} -> ${result.version} [${result.distributions.join(",")}]`
      : `updated ${current ?? "new install"} -> ${result.version}${
        pruned.length > 0 ? `; pruned ${pruned.join(", ")}` : ""
      }`,
    { ...result, pruned },
  );
}

function rollbackCommand(argv: string[]): ReturnType<typeof success> {
  if (argv.includes("--list")) {
    const { versions, pinWarnings } = retainedVersions();
    const eligible = versions.filter((item) => item.complete && !item.active);
    return success(
      (eligible.length
        ? eligible.map((item) => `${item.version} [${item.distributions.join(",")}]`).join("\n")
        : "no rollback target") +
        (pinWarnings.length > 0 ? `\nwarning: ${pinWarnings.join("; ")}` : ""),
      { versions: eligible, pinWarnings },
    );
  }
  const target = valueAfter(argv, "--version") ||
    (existsSync(rollbackVersionPath()) ? readFileSync(rollbackVersionPath(), "utf-8").trim() : "");
  if (!target) {
    commandError("no prior version is recorded; run aidlc use <version>", EXIT.failure);
  }
  if (valueAfter(argv, "--version")) {
    requestedVersion(target);
  } else {
    try {
      requireVersion(target);
    } catch (error) {
      commandError(
        `recorded rollback version is invalid: ${error instanceof Error ? error.message : String(error)}`,
        EXIT.integrity,
      );
    }
  }
  const active = activeVersion();
  const missing = active
    ? installedDistributions(active).filter((item) => !installedDistributions(target).includes(item))
    : [];
  if (missing.length > 0 && !argv.includes("--allow-harness-loss")) {
    throw new Error(`rollback target lacks harnesses: ${missing.join(", ")}`);
  }
  activate(target);
  return success(`rolled back to ${target}`, { version: target });
}

export async function configureProjectPin(argv: string[]): Promise<CommandResult> {
  try {
    const hasPin = argv.includes("--pin");
    const hasUnpin = argv.includes("--unpin");
    if (hasPin === hasUnpin) {
      return usage("usage: aidlc config --pin <version> | aidlc config --unpin");
    }
    if (argv.includes("--harness")) return usage("unknown argument: --harness");
    const projectDir = projectDirFrom(argv);
    if (hasUnpin) {
      commitProjectPin(projectDir, null);
      return success(
        "Removed this project's AI-DLC version pin; it now follows the active machine version.",
        { projectDir, version: activeVersion(), pinned: false },
      );
    }
    const requested = valueAfter(argv, "--pin");
    if (!requested) return usage("--pin requires a strict version");
    const version = requestedVersion(requested);
    if (existsSync(versionRoot(version)) && !completeVersion(version)) {
      const reason = inspectInstalledVersion(version).reason ?? "integrity validation failed";
      commandError(`retained version ${version} is incomplete: ${reason}`, EXIT.integrity);
    }
    if (!completeVersion(version)) {
      await installVersion({
        version,
        from: valueAfter(argv, "--from"),
        offline: offline(argv),
        activate: false,
        dryRun: false,
        baseUrl: valueAfter(argv, "--release-base-url"),
        caBundle: valueAfter(argv, "--ca-bundle"),
      });
    }
    const distribution = projectDistribution(projectDir);
    if (distribution && !inspectInstalledVersion(version, distribution).complete) {
      commandError(`${version} does not contain this project's ${distribution} runtime`, EXIT.usage);
    }
    commitProjectPin(projectDir, version);
    return success(
      `Pinned this project to aidlc ${version}. Commit .aidlc-version to share the pin.`,
      { projectDir, version, pinned: true },
    );
  } catch (error) {
    return lifecycleFailureResult(error, argv);
  }
}

async function useCommand(argv: string[]): Promise<CommandResult> {
  const value = argv[1];
  if (!value || value.startsWith("--")) return usage("usage: aidlc use <version>");
  if (argv.includes("--pin")) {
    return usage("use --pin is not supported; run aidlc config --pin <version>");
  }
  if (value === "current") {
    return usage("use current is not supported; run aidlc config --unpin");
  }
  if (argv.includes("--harness")) return usage("unknown argument: --harness");
  const version = requestedVersion(value);
  if (existsSync(versionRoot(version)) && !completeVersion(version)) {
    const reason = inspectInstalledVersion(version).reason ?? "integrity validation failed";
    commandError(`retained version ${version} is incomplete: ${reason}`, EXIT.integrity);
  }
  if (!completeVersion(version)) {
    await installVersion({
      version,
      from: valueAfter(argv, "--from"),
      offline: offline(argv),
      activate: false,
      dryRun: false,
      baseUrl: valueAfter(argv, "--release-base-url"),
      caBundle: valueAfter(argv, "--ca-bundle"),
    });
  }
  activate(version);
  return success(`active AI-DLC version set to ${version}`, { version });
}

function installProfileCommand(argv: string[]): CommandResult {
  const profileValue = valueAfter(argv, "--profile");
  const binValue = valueAfter(argv, "--bin-dir");
  if (!profileValue || !binValue) {
    return usage(
      "install-profile writes the invoking user's shell profile; requires --profile <path> and --bin-dir <path>",
    );
  }
  const profile = resolve(profileValue);
  const bin = resolve(binValue);
  const home = resolve(process.env.HOME || "");
  if (!process.env.HOME) {
    return failure("profile path must be inside the target user's home directory", EXIT.integrity);
  }
  let profileRelative: string;
  try {
    profileRelative = relative(
      realpathSync(home),
      join(realpathSync(dirname(profile)), basename(profile)),
    );
  } catch {
    return failure(
      "profile parent must exist inside the target user's home directory",
      EXIT.integrity,
    );
  }
  if (
    profileRelative === ".." ||
    profileRelative.startsWith(`..${sep}`) ||
    isAbsolute(profileRelative)
  ) {
    return failure("profile path must be inside the target user's home directory", EXIT.integrity);
  }
  let profileMode = 0o600;
  let profileExists = false;
  try {
    const stat = lstatSync(profile);
    profileExists = true;
    profileMode = stat.mode & 0o777;
    if (!stat.isFile()) {
      return failure("profile path is not a regular file", EXIT.integrity);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const begin = "# BEGIN AI-DLC:PATH";
  const end = "# END AI-DLC:PATH";
  const current = profileExists ? readFileSync(profile, "utf-8") : "";
  const begins = current.split(begin).length - 1;
  const ends = current.split(end).length - 1;
  if (begins > 1 || ends > 1 || begins !== ends) {
    return failure("profile AI-DLC PATH markers are missing, duplicated, or malformed", EXIT.integrity);
  }
  const escapedBin = bin.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")
    .replaceAll("$", "\\$").replaceAll("`", "\\`");
  const block = `${begin}\nexport PATH="${escapedBin}:$PATH"\n${end}`;
  let next: string;
  if (begins === 1) {
    const start = current.indexOf(begin);
    const finish = current.indexOf(end, start + begin.length) + end.length;
    next = `${current.slice(0, start)}${block}${current.slice(finish)}`;
  } else {
    const prefix = current.length === 0 || current.endsWith("\n") ? current : `${current}\n`;
    next = `${prefix}${prefix.length > 0 ? "\n" : ""}${block}\n`;
  }
  executePlan({
    schemaVersion: 1,
    root: dirname(profile),
    operations: [writeOperation(
      basename(profile),
      next,
      transactionState(profile),
      profileMode,
    )],
  });
  return success(`updated ${profile} with an owned AI-DLC PATH block`, { profile, bin });
}

export async function main(input: string[]): Promise<void> {
  const argv = input;
  const options = globalOptions(argv);
  try {
    const command = argv[0];
    const result = command === "versions"
      ? await versionsCommand(argv)
      : command === "update"
      ? await updateCommand(argv)
      : command === "rollback"
      ? rollbackCommand(argv)
      : command === "use"
      ? await useCommand(argv)
      : command === "uninstall"
      ? uninstallCommand(argv)
      : command === "install-profile"
      ? installProfileCommand(argv)
      : command === "install-apply"
      ? success(
          `installed ${(await installVersion({
            version: valueAfter(argv, "--version"),
            from: valueAfter(argv, "--from"),
            offline: true,
            activate: true,
            dryRun: false,
            baseUrl: valueAfter(argv, "--release-base-url"),
            caBundle: valueAfter(argv, "--ca-bundle"),
          })).version}`,
        )
      : usage("unknown lifecycle command");
    emitResult(result, options);
  } catch (error) {
    emitResult(lifecycleFailureResult(error, argv), options);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`aidlc lifecycle: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT.failure;
  });
}
