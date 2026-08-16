#!/usr/bin/env bun
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { extractTarGz } from "./aidlc-archive.ts";
import {
  EXIT,
  emitResult,
  failure,
  globalOptions,
  success,
  usage,
  valueAfter,
  valuesAfter,
} from "./aidlc-command.ts";
import {
  type ProjectionDescriptor,
  projectionFiles,
  sha256Bytes,
  sha256File,
  walkFiles,
} from "./aidlc-distribution.ts";
import { activeVersion, projectDirFrom, runtimeRoot } from "./aidlc-install-paths.ts";
import { defaultHarnessPath } from "./aidlc-machine-config.ts";
import { configureProjectPin } from "./aidlc-lifecycle.ts";
import {
  type TransactionOperation,
  type TransactionPlan,
  executePlan,
  transactionState,
  writeOperation,
} from "./aidlc-transaction.ts";
import { compileStageGraph, __resetGraphCache } from "./aidlc-graph.ts";
import {
  _resetHarnessDataForTests,
  _resetScopeMappingForTests,
  _resetStageGraphForTests,
  getField,
  listIntents,
  listSpaces,
  stateFilePath,
  withAuditLock,
} from "./aidlc-lib.ts";
import { regenerateRunnerSurfaces } from "./aidlc-runner-gen.ts";
import {
  canonicalScopeTableRegion,
  canonicalStageTableRegion,
  renderScopeTable,
  renderStageTable,
} from "./aidlc-utility.ts";
import {
  discoverProjectHarnesses,
} from "./aidlc-runtime-paths.ts";
import {
  activeModelGroups,
  applyModelPolicyToProjection,
  harnessHonestyNotes,
  isModelEffort,
  isModelPreset,
  MODEL_EFFORTS,
  MODEL_GROUPS,
  MODEL_PRESETS,
  modelPolicyIsEmpty,
  modelPolicySurfaceDrift,
  normalizeModelPolicy,
  profileGroups,
  readAgentTiers,
  resolveModelPolicy,
  type AgentTiers,
  type ModelEffort,
  type ModelGroup,
  type ModelHarness,
  type ModelPolicyRecord,
  type ModelProfile,
} from "./aidlc-model-policy.ts";
import { resolveTierCap } from "./aidlc-tiers.ts";

type RootContribution =
  | { policy: "managed-block"; hash: string; marker?: string }
  | { policy: "json-map"; entries: Record<string, string>; key?: string }
  | { policy: "json-array"; entries: Record<string, string>; key: string }
  | { policy: "whole-file"; hash: string };

type Baseline = {
  schemaVersion: 1;
  frameworkVersion: string;
  distribution: string;
  harnessDir: string;
  mcpMode: "defaults" | "none";
  files: Record<string, string>;
  rootContributions: Record<string, RootContribution>;
};

type PlannedAction = {
  path: string;
  action: "create" | "update" | "merge" | "preserve" | "remove" | "conflict";
  detail?: string;
};

type ModelsMutationContext = {
  harness: ModelHarness;
  harnessDir: string;
  previous: ModelPolicyRecord | null;
  next: ModelPolicyRecord | null;
  tiers: AgentTiers;
  summaryLines: string[];
  notes: string[];
};

const CONFIG_VALUE_FLAGS = new Set([
  "--agent",
  "--ca-bundle",
  "--deciding-effort",
  "--effort",
  "--from",
  "--harness",
  "--mcp",
  "--model",
  "--output",
  "--pin",
  "--plan-token",
  "--preset",
  "--project-dir",
  "--release-base-url",
  "--reviewing-effort",
  "--save-as",
  "--writing-up-effort",
]);

const MODELS_VALUE_FLAGS = new Set([
  "--agent",
  "--deciding-effort",
  "--effort",
  "--from",
  "--harness",
  "--model",
  "--plan-token",
  "--preset",
  "--project-dir",
  "--reviewing-effort",
  "--save-as",
  "--writing-up-effort",
]);

const MODELS_BARE_FLAGS = new Set([
  "--check",
  "--dry-run",
  "--help",
  "--json",
  "--no-color",
  "--quiet",
  "--reset",
  "--show",
  "--verbose",
  "--yes",
]);

function configPositionals(argv: readonly string[]): Array<{ value: string; index: number }> {
  const positionals: Array<{ value: string; index: number }> = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (CONFIG_VALUE_FLAGS.has(token)) {
      index++;
      continue;
    }
    if (!token.startsWith("--")) positionals.push({ value: token, index });
  }
  return positionals;
}

function modelHarness(value: string): ModelHarness {
  if (
    value === "claude" ||
    value === "codex" ||
    value === "copilot" ||
    value === "cursor" ||
    value === "kiro" ||
    value === "kiro-ide" ||
    value === "opencode"
  ) {
    return value;
  }
  throw new Error(`models policy is not supported for harness ${JSON.stringify(value)}`);
}

function modelPolicyFromHarnessRoot(harnessRoot: string): ModelPolicyRecord | null {
  const path = join(harnessRoot, "tools", "data", "harness.json");
  const value = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  return normalizeModelPolicy(value.models);
}

function cloneModelPolicy(policy: ModelPolicyRecord | null): ModelPolicyRecord {
  return policy
    ? JSON.parse(JSON.stringify(policy)) as ModelPolicyRecord
    : { schemaVersion: 1 };
}

function validateModelsArgs(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      return `unexpected models positional ${JSON.stringify(token)}`;
    }
    if (MODELS_VALUE_FLAGS.has(token)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) return `${token} requires a value`;
      index++;
      continue;
    }
    if (!MODELS_BARE_FLAGS.has(token)) return `unknown models option ${token}`;
  }
  if (valuesAfter(argv, "--harness").length > 1) {
    return "multi-harness config is not supported yet; pass one --harness <name>";
  }
  if (valuesAfter(argv, "--agent").length > 1) {
    return "one models mutation may target only one --agent";
  }
  return null;
}

function modelPolicyHelp(): string {
  return [
    "Usage: aidlc config models [options]",
    "",
    "Pins bind in both directions: a pinned agent stays pinned if the session later moves to a larger model.",
    "The framework never raises an agent above the session on its own; shipped tiers only step down.",
    "",
    "Policy:",
    "  --preset <thorough|economical>",
    "  --from <preset|profile> [--save-as <name>]",
    "  --deciding-effort <low|medium|high|xhigh|max>",
    "  --reviewing-effort <low|medium|high|xhigh|max>",
    "  --writing-up-effort <low|medium|high|xhigh|max>",
    "  --agent <name> --effort <value> [--model <raw-id>]",
    "  --reset",
    "",
    "Inspection:",
    "  --show [--json]",
    "  --check",
    "",
    "Mutation control:",
    "  --dry-run",
    "  --yes",
  ].join("\n");
}

function modelStateData(
  policy: ModelPolicyRecord | null,
  tiers: AgentTiers,
  harness: ModelHarness,
  projectDir: string,
): {
  harness: ModelHarness;
  policy: ModelPolicyRecord | null;
  effective: ReturnType<typeof resolveModelPolicy>[];
  notes: string[];
} {
  const cap = resolveTierCap(join(projectDir, "aidlc", "spaces", "default", "memory"));
  const effective = Object.entries(tiers).sort(([left], [right]) =>
    left.localeCompare(right)
  ).map(([name, tier]) => resolveModelPolicy(policy, name, tier, harness, cap));
  return {
    harness,
    policy,
    effective,
    notes: harnessHonestyNotes(policy, tiers, harness, cap),
  };
}

function showModels(
  policy: ModelPolicyRecord | null,
  tiers: AgentTiers,
  harness: ModelHarness,
  projectDir: string,
  options: ReturnType<typeof globalOptions>,
): void {
  const data = modelStateData(policy, tiers, harness, projectDir);
  if (options.mode === "json") {
    emitResult(success(`model policy for ${harness}`, data), options);
    return;
  }
  let output = `Model policy for ${harness}\n`;
  for (const item of data.effective) {
    output += `  ${item.agent} [${MODEL_GROUPS[item.group].label}] ${
      item.model ?? "inherit"
    }/${item.effort ?? "inherit"}\n`;
    output += `    provenance: ${item.layer}`;
    if (item.unexpressed.length > 0) {
      output += `; not expressible: ${item.unexpressed.join(", ")}`;
    }
    output += "\n";
  }
  for (const note of data.notes) output += `  Note: ${note}\n`;
  process.stdout.write(output);
  process.exitCode = EXIT.ok;
}

function modelsPipelineArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  const keptValues = new Set(["--harness", "--plan-token", "--project-dir"]);
  const keptBare = new Set([
    "--dry-run",
    "--json",
    "--no-color",
    "--quiet",
    "--verbose",
    "--yes",
  ]);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (keptValues.has(token)) {
      out.push(token, argv[++index]);
    } else if (keptBare.has(token)) {
      out.push(token);
    } else if (MODELS_VALUE_FLAGS.has(token)) {
      index++;
    }
  }
  return out;
}

function modelEffortFlag(
  argv: readonly string[],
  group: ModelGroup,
): ModelEffort | undefined {
  const flag = `--${group}-effort`;
  const value = valueAfter(argv, flag);
  if (value === undefined) return undefined;
  if (!isModelEffort(value)) {
    throw new Error(`${flag} must be one of ${MODEL_EFFORTS.join(", ")}`);
  }
  return value;
}

function applyModelsFlags(
  current: ModelPolicyRecord | null,
  argv: readonly string[],
  tiers: AgentTiers,
): ModelPolicyRecord | null {
  if (argv.includes("--reset")) {
    const conflicting = [
      "--agent",
      "--deciding-effort",
      "--effort",
      "--from",
      "--model",
      "--preset",
      "--reviewing-effort",
      "--save-as",
      "--writing-up-effort",
    ].find((flag) => argv.includes(flag));
    if (conflicting) throw new Error(`--reset cannot be combined with ${conflicting}`);
    return null;
  }
  const next = cloneModelPolicy(current);
  const preset = valueAfter(argv, "--preset");
  const from = valueAfter(argv, "--from");
  const saveAs = valueAfter(argv, "--save-as");
  if (preset && from) throw new Error("--preset and --from are mutually exclusive");
  if (preset) {
    if (!isModelPreset(preset)) {
      throw new Error(`--preset must be one of ${Object.keys(MODEL_PRESETS).join(", ")}`);
    }
    next.preset = preset;
    delete next.groups;
  }
  if (saveAs && !from) throw new Error("--save-as requires --from <preset|profile>");
  if (saveAs && !/^[a-z0-9][a-z0-9-]*$/.test(saveAs)) {
    throw new Error("--save-as must use lowercase letters, digits, and hyphens");
  }
  if (from) {
    const groups = profileGroups(current, from);
    next.groups = groups;
    if (isModelPreset(from) && !saveAs) next.preset = from;
    else delete next.preset;
  }
  for (const group of Object.keys(MODEL_GROUPS) as ModelGroup[]) {
    const effort = modelEffortFlag(argv, group);
    if (!effort) continue;
    next.groups ??= {};
    next.groups[group] = { effort };
  }
  if (saveAs) {
    next.profiles ??= {};
    next.profiles[saveAs] = {
      groups: JSON.parse(JSON.stringify(next.groups ?? {})) as ModelProfile["groups"],
    };
  }
  const agent = valueAfter(argv, "--agent");
  const effort = valueAfter(argv, "--effort");
  const model = valueAfter(argv, "--model");
  if (agent && !(agent in tiers)) {
    throw new Error(
      `unknown agent ${JSON.stringify(agent)}; use one of ${Object.keys(tiers).sort().join(", ")}`,
    );
  }
  if (agent && !effort) throw new Error("--agent requires --effort <value>");
  if (!agent && (effort || model)) throw new Error("--effort and --model require --agent <name>");
  if (effort && !isModelEffort(effort)) {
    throw new Error(`--effort must be one of ${MODEL_EFFORTS.join(", ")}`);
  }
  if (agent && effort) {
    next.agents ??= {};
    next.agents[agent] = {
      ...(next.agents[agent] ?? {}),
      effort: effort as ModelEffort,
      ...(model ? { model } : {}),
    };
  }
  return modelPolicyIsEmpty(next) ? null : normalizeModelPolicy(next);
}

function groupPolicyEffort(
  policy: ModelPolicyRecord | null,
  group: ModelGroup,
): ModelEffort | undefined {
  return activeModelGroups(policy)[group]?.effort;
}

function effortTradeoff(group: ModelGroup, effort: ModelEffort): string {
  if (group === "reviewing" && effort === "xhigh") {
    return "Deeper review passes. Cost: roughly 9x the wall-clock per review (#612 data).";
  }
  if (effort === "low" || effort === "medium") {
    return group === "deciding"
      ? "Faster decisions with less deliberation."
      : group === "reviewing"
      ? "Faster review passes with less deliberation."
      : "Faster plans, pipelines, and runbooks with less polish.";
  }
  return MODEL_GROUPS[group].tradeoff;
}

function modelSummaryLines(
  previous: ModelPolicyRecord | null,
  next: ModelPolicyRecord | null,
  tiers: AgentTiers,
  harness: ModelHarness,
  projectDir: string,
): { lines: string[]; notes: string[] } {
  const cap = resolveTierCap(join(projectDir, "aidlc", "spaces", "default", "memory"));
  const lines: string[] = [];
  for (const group of Object.keys(MODEL_GROUPS) as ModelGroup[]) {
    const beforeDial = groupPolicyEffort(previous, group);
    const afterDial = groupPolicyEffort(next, group);
    if (beforeDial === afterDial) continue;
    const names = Object.entries(tiers)
      .filter(([, tier]) => MODEL_GROUPS[group].tier === tier)
      .map(([name]) => name)
      .sort();
    const name = names[0];
    if (!name) continue;
    const tier = tiers[name];
    const before = resolveModelPolicy(previous, name, tier, harness, cap);
    const after = resolveModelPolicy(next, name, tier, harness, cap);
    if (after.unexpressed.includes("effort")) {
      lines.push(
        `  ${MODEL_GROUPS[group].label.padEnd(11)} ${names.length} agents   ` +
          `${afterDial ?? "inherit"} requested; ${harnessHonestyNotes(next, tiers, harness, cap)[0]}`,
      );
      continue;
    }
    const beforeModel = before.model ?? "inherit";
    const afterModel = after.model ?? "inherit";
    const suffix = beforeModel === afterModel ? " (model unchanged)" : "";
    lines.push(
      `  ${MODEL_GROUPS[group].label.padEnd(11)} ${names.length} agents   ` +
        `${beforeModel}/${before.effort ?? "inherit"} -> ` +
        `${afterModel}/${after.effort ?? "inherit"}${suffix}`,
    );
    if (afterDial) lines.push(`  ${effortTradeoff(group, afterDial)}`);
  }
  const notes = harnessHonestyNotes(next, tiers, harness, cap);
  return { lines, notes };
}

function modelsWizard(
  current: ModelPolicyRecord | null,
  tiers: AgentTiers,
  harness: ModelHarness,
  projectDir: string,
): ModelPolicyRecord | null {
  showModels(current, tiers, harness, projectDir, {
    mode: "human",
    color: false,
    yes: false,
    offline: true,
    verbose: false,
  });
  process.stdout.write(
    "Pins bind in both directions, and shipped tiers never raise an agent above the session.\n",
  );
  const choice = prompt(
    "Models [Enter keep everything, 1 preset, 2 group efforts, 3 set each one myself]:",
  )?.trim();
  if (!choice) return current;
  if (choice === "1") {
    const selected = prompt("Preset [thorough/economical]:")?.trim() ?? "";
    if (!isModelPreset(selected)) throw new Error("preset selection cancelled");
    return applyModelsFlags(current, ["--preset", selected], tiers);
  }
  if (choice === "2") {
    const args: string[] = [];
    for (const group of Object.keys(MODEL_GROUPS) as ModelGroup[]) {
      const currentValue = groupPolicyEffort(current, group) ?? "shipped";
      process.stdout.write(
        `${MODEL_GROUPS[group].label}: current ${currentValue}. ${MODEL_GROUPS[group].tradeoff}\n`,
      );
      const answer = prompt(
        `${MODEL_GROUPS[group].label} effort [low/medium/high/xhigh/max, Enter keep]:`,
      )?.trim();
      if (!answer) continue;
      if (!isModelEffort(answer)) throw new Error(`invalid effort ${JSON.stringify(answer)}`);
      args.push(`--${group}-effort`, answer);
    }
    return args.length > 0 ? applyModelsFlags(current, args, tiers) : current;
  }
  if (choice === "3") {
    let next = current;
    for (const name of Object.keys(tiers).sort()) {
      const currentValue = resolveModelPolicy(next, name, tiers[name], harness);
      process.stdout.write(
        `${name}: current ${currentValue.model ?? "inherit"}/${currentValue.effort ?? "inherit"}.\n`,
      );
      const effort = prompt(
        `${name} effort [low/medium/high/xhigh/max, Enter keep]:`,
      )?.trim();
      if (!effort) continue;
      if (!isModelEffort(effort)) throw new Error(`invalid effort ${JSON.stringify(effort)}`);
      const model = prompt(`${name} raw model id [Enter inherit]:`)?.trim();
      next = applyModelsFlags(
        next,
        ["--agent", name, "--effort", effort, ...(model ? ["--model", model] : [])],
        tiers,
      );
    }
    return next;
  }
  throw new Error("models selection cancelled");
}

function stripVerb(argv: string[]): string[] {
  return argv[0] === "config" || argv[0] === "init" ? argv.slice(1) : argv;
}

function readBaseline(path: string): Baseline | null {
  if (!pathPresent(path)) return null;
  if (!regularFile(path)) throw new Error(`cannot refresh from ${path}: baseline is not a regular file`);
  try {
    const value = JSON.parse(readFileSync(path, "utf-8")) as Baseline;
    if (value.schemaVersion !== 1) throw new Error(`unsupported schema ${value.schemaVersion}`);
    return value;
  } catch (error) {
    throw new Error(`cannot refresh from ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function expected(path: string): string | "absent" {
  return transactionState(path);
}

function pathPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function regularFile(path: string): boolean {
  return pathPresent(path) && lstatSync(path).isFile();
}

function regularFilesBelow(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push(relative(root, path));
    }
  };
  visit(root);
  return files;
}

function runtimeGenerated(
  rel: string,
  harnessDir: string,
  regenerated: ReadonlySet<string>,
): boolean {
  const normalized = rel.replaceAll("\\", "/");
  return regenerated.has(normalized) || [
    `${harnessDir}/tools/data/harness.json`,
    `${harnessDir}/tools/data/stage-graph.json`,
    `${harnessDir}/tools/data/scope-grid.json`,
  ].includes(normalized);
}

type StageContribRecord = {
  produces?: string[];
  sensors?: string[];
  consumes?: string[];
  required_sections?: string[];
  required_sections_created?: boolean;
};

function resetProjectionCaches(): void {
  __resetGraphCache();
  _resetHarnessDataForTests();
  _resetScopeMappingForTests();
  _resetStageGraphForTests();
}

function mergeListField(content: string, field: string, items: readonly string[]): string {
  if (items.length === 0) return content;
  const empty = new RegExp(`^${field}:\\s*\\[\\s*\\]\\s*$`, "m");
  if (empty.test(content)) {
    return content.replace(empty, `${field}:\n${items.map((item) => `  - ${item}`).join("\n")}`);
  }
  const block = new RegExp(`^(${field}:\\n(?:  - .+\\n)*)`, "m");
  const match = content.match(block);
  if (!match) return content;
  const existing = new Set(
    [...match[1].matchAll(/^ {2}- (.+)$/gm)].map((item) =>
      item[1].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")
    ),
  );
  const additions = items.filter((item) => !existing.has(item));
  if (additions.length === 0) return content;
  const quoted = field === "required_sections";
  return content.replace(
    block,
    `${match[1]}${additions.map((item) => `  - ${quoted ? JSON.stringify(item) : item}`).join("\n")}\n`,
  );
}

function mergeRequiredSections(content: string, record: StageContribRecord): string {
  const items = record.required_sections ?? [];
  if (items.length === 0) return content;
  if (/^required_sections:/m.test(content)) {
    return mergeListField(content, "required_sections", items);
  }
  const close = /^---\r?\n[\s\S]*?\n(---)(?:\r?\n|$)/.exec(content);
  if (!close) return content;
  const at = (close.index ?? 0) + close[0].lastIndexOf("---");
  return `${content.slice(0, at)}required_sections:\n${
    items.map((item) => `  - ${JSON.stringify(item)}`).join("\n")
  }\n${content.slice(at)}`;
}

function consumeBlocks(content: string, names: ReadonlySet<string>): string[] {
  const block = /^consumes:\n((?: {2}- artifact:.*\n(?: {4}(?:required|conditional_on):.*\n)*)*)/m.exec(content);
  if (!block) return [];
  return [...block[1].matchAll(/^ {2}- artifact:\s*([\w-]+).*\n(?: {4}(?:required|conditional_on):.*\n)*/gm)]
    .filter((entry) => names.has(entry[1]))
    .map((entry) => entry[0].trimEnd());
}

function mergeConsumes(content: string, blocks: readonly string[]): string {
  if (blocks.length === 0) return content;
  if (/^consumes:\s*\[\s*\]\s*$/m.test(content)) {
    return content.replace(/^consumes:\s*\[\s*\]\s*$/m, `consumes:\n${blocks.join("\n")}`);
  }
  const match = /^(consumes:\n(?: {2}- artifact:.*\n(?: {4}(?:required|conditional_on):.*\n)*)*)/m.exec(content);
  if (!match) return content;
  const existing = new Set([...match[1].matchAll(/- artifact:\s*([\w-]+)/g)].map((item) => item[1]));
  const additions = blocks.filter((block) => {
    const name = /- artifact:\s*([\w-]+)/.exec(block)?.[1];
    return name && !existing.has(name);
  });
  return additions.length === 0
    ? content
    : content.replace(match[0], `${match[1]}${additions.join("\n")}\n`);
}

function stripRecordedContributions(content: string, record: StageContribRecord): string {
  let value = content;
  for (const [field, items] of [
    ["produces", record.produces],
    ["sensors", record.sensors],
    ["required_sections", record.required_sections],
  ] as const) {
    if (!items?.length) continue;
    const values = new Set(items);
    const block = new RegExp(`^${field}:\\n((?: {2}- .+\\n)*)`, "m");
    const match = value.match(block);
    if (!match) continue;
    const kept = [...match[1].matchAll(/^ {2}- (.+)$/gm)]
      .map((item) => item[1])
      .filter((item) => !values.has(item.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")));
    const replacement = kept.length > 0
      ? `${field}:\n${kept.map((item) => `  - ${item}`).join("\n")}\n`
      : field === "required_sections" && record.required_sections_created
      ? ""
      : `${field}: []\n`;
    value = value.replace(block, replacement);
  }
  if (record.consumes?.length) {
    const names = new Set(record.consumes);
    const block = /^consumes:\n((?: {2}- artifact:.*\n(?: {4}(?:required|conditional_on):.*\n)*)*)/m.exec(value);
    if (block) {
      const kept = [...block[1].matchAll(/^ {2}- artifact:\s*([\w-]+).*\n(?: {4}(?:required|conditional_on):.*\n)*/gm)]
        .filter((entry) => !names.has(entry[1]))
        .map((entry) => entry[0]);
      value = value.replace(block[0], kept.length > 0 ? `consumes:\n${kept.join("")}` : "consumes: []\n");
    }
  }
  return stripPluginFragments(value);
}

function stripPluginFragments(content: string): string {
  return content.replace(
    /<!-- plugin:([^:\n]+):([^\n]+?):(\d+):([0-9a-f]+) -->\n[\s\S]*?<!-- \/plugin:\1:\2:\3:\4 -->\n?/g,
    "",
  ).replace(/\n{3,}/g, "\n\n");
}

function pluginFragments(content: string): Array<{ marker: string; anchor: string; block: string }> {
  const fragments: Array<{ marker: string; anchor: string; block: string }> = [];
  const open = /<!-- plugin:([^:\n]+):([^\n]+?):(\d+):([0-9a-f]+) -->/g;
  for (const match of content.matchAll(open)) {
    const marker = match[0];
    const close = `<!-- /plugin:${match[1]}:${match[2]}:${match[3]}:${match[4]} -->`;
    const end = content.indexOf(close, match.index);
    if (end < 0) continue;
    fragments.push({
      marker,
      anchor: match[2],
      block: content.slice(match.index, end + close.length),
    });
  }
  return fragments;
}

function anchorOffset(content: string, anchor: string): number {
  const step = /^(after|before)-step:(\d+)$/.exec(anchor);
  if (step) {
    const wanted = Number(step[2]);
    for (const match of content.matchAll(/^### Step (\d+)(?:-(\d+))?\b.*$/gm)) {
      const low = Number(match[1]);
      const high = match[2] ? Number(match[2]) : low;
      if (wanted < low || wanted > high) continue;
      if (step[1] === "before") return match.index ?? -1;
      const from = (match.index ?? 0) + match[0].length;
      const next = content.slice(from).search(/^#{2,3} /m);
      return next < 0 ? content.length : from + next;
    }
    return -1;
  }
  if (anchor === "end-of-steps") {
    const section = /^## Steps\b.*$/m.exec(content);
    if (!section) return -1;
    const from = (section.index ?? 0) + section[0].length;
    const next = content.slice(from).search(/^## /m);
    return next < 0 ? content.length : from + next;
  }
  if (anchor.startsWith("in:")) {
    const section = new RegExp(`^## ${anchor.slice(3).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b.*$`, "m")
      .exec(content);
    if (!section) return -1;
    const from = (section.index ?? 0) + section[0].length;
    const next = content.slice(from).search(/^## /m);
    return next < 0 ? content.length : from + next;
  }
  return -1;
}

function mergePluginFragments(
  fresh: string,
  fragments: readonly { marker: string; anchor: string; block: string }[],
): string {
  let value = fresh;
  for (const fragment of fragments) {
    if (value.includes(fragment.marker)) continue;
    const offset = anchorOffset(value, fragment.anchor);
    if (offset < 0) {
      throw new Error(`cannot reapply plugin fragment at missing anchor ${fragment.anchor}`);
    }
    value = `${value.slice(0, offset)}\n${fragment.block}\n${value.slice(offset)}`;
  }
  return value;
}

function replaceGeneratedRegion(
  current: string,
  generated: string,
  kind: "stage" | "scope",
): string {
  const noun = kind === "stage" ? "stage graph" : "scope grid";
  const beginPrefix = `<!-- BEGIN: compiled ${noun} via `;
  const end = `<!-- END: compiled ${noun} -->`;
  const locate = (content: string): {
    begin: number;
    beginLineEnd: number;
    endStart: number;
    end: number;
  } => {
    const begin = content.indexOf(beginPrefix);
    const beginLineEnd = content.indexOf("-->", begin);
    const endAt = content.indexOf(end, beginLineEnd);
    if (begin < 0 || beginLineEnd < 0 || endAt < 0) {
      throw new Error(`SKILL.md is missing the compiled ${noun} region`);
    }
    return {
      begin,
      beginLineEnd: beginLineEnd + 3,
      endStart: endAt,
      end: endAt + end.length,
    };
  };
  const target = locate(current);
  const source = locate(generated);
  return `${current.slice(0, target.begin)}${
    current.slice(target.begin, target.beginLineEnd)
  }${generated.slice(source.beginLineEnd, source.endStart)}${
    current.slice(target.endStart, target.end)
  }${current.slice(target.end)}`;
}

function generatedOverlayCandidate(rel: string, harnessDir: string): boolean {
  return rel.startsWith(`${harnessDir}/aidlc-common/stages/`) ||
    rel.startsWith(`${harnessDir}/scopes/`) ||
    rel.startsWith(`${harnessDir}/agents/`) ||
    rel.startsWith(`${harnessDir}/knowledge/`) ||
    rel.startsWith(`${harnessDir}/sensors/`) ||
    rel.startsWith(`${harnessDir}/tools/`) ||
    rel.startsWith(`${harnessDir}/skills/`) ||
    rel.startsWith(".agents/skills/");
}

const HARNESS_IDENTITY_KEYS = new Set([
  "schemaVersion",
  "distribution",
  "productName",
  "configNextStep",
  "harnessDir",
  "rulesSubdir",
]);

function prepareRefreshSource(
  projectDir: string,
  sourceRoot: string,
  descriptor: ProjectionDescriptor,
  prior: Baseline | null,
  modelsOverride?: ModelPolicyRecord | null,
): { root: string; cleanup?: string; regenerated: Set<string> } {
  const currentHarness = join(projectDir, descriptor.harnessDir);
  const currentHarnessData = join(currentHarness, "tools", "data", "harness.json");
  if (!prior && !regularFile(currentHarnessData) && modelsOverride === undefined) {
    return { root: sourceRoot, regenerated: new Set() };
  }
  const cleanup = mkdtempSync(join(tmpdir(), "aidlc-init-refresh-"));
  try {
  const root = join(cleanup, "projection");
  cpSync(sourceRoot, root, { recursive: true, preserveTimestamps: true });
  const regenerated = new Set<string>();
  const stagedHarness = join(root, descriptor.harnessDir);

  const stagedHarnessData = join(stagedHarness, "tools", "data", "harness.json");
  const staged = JSON.parse(readFileSync(stagedHarnessData, "utf-8")) as Record<string, unknown>;
  if (regularFile(currentHarnessData)) {
    const current = JSON.parse(readFileSync(currentHarnessData, "utf-8")) as Record<string, unknown>;
    for (const [key, value] of Object.entries(current)) {
      if (!HARNESS_IDENTITY_KEYS.has(key)) staged[key] = value;
    }
  }
  if (modelsOverride === null) delete staged.models;
  else if (modelsOverride !== undefined) staged.models = modelsOverride;
  if (regularFile(currentHarnessData) || modelsOverride !== undefined) {
    writeFileSync(stagedHarnessData, `${JSON.stringify(staged, null, 2)}\n`);
    regenerated.add(`${descriptor.harnessDir}/tools/data/harness.json`);
  }
  const distribution = staged.distribution;
  if (typeof distribution !== "string") {
    throw new Error(`${stagedHarnessData}: distribution must be a string`);
  }
  applyModelPolicyToProjection(
    root,
    descriptor.harnessDir,
    modelHarness(distribution),
    normalizeModelPolicy(staged.models),
  );

  const currentGrid = join(currentHarness, "tools", "data", "scope-grid.json");
  const stagedGrid = join(stagedHarness, "tools", "data", "scope-grid.json");
  if (regularFile(currentGrid)) {
    cpSync(currentGrid, stagedGrid);
    regenerated.add(`${descriptor.harnessDir}/tools/data/scope-grid.json`);
  }

  for (const directory of descriptor.managedDirectories) {
    if (directory !== descriptor.harnessDir && directory !== ".agents") continue;
    const currentDir = join(projectDir, directory);
    if (!pathPresent(currentDir) || !lstatSync(currentDir).isDirectory()) continue;
    for (const nested of regularFilesBelow(currentDir)) {
      const rel = join(directory, nested).replaceAll("\\", "/");
      const staged = join(root, rel);
      if (
        existsSync(staged) ||
        prior?.files[rel] ||
        !generatedOverlayCandidate(rel, descriptor.harnessDir)
      ) continue;
      mkdirSync(dirname(staged), { recursive: true });
      cpSync(join(projectDir, rel), staged, { preserveTimestamps: true });
      regenerated.add(rel);
    }
  }

  const records = new Map<string, StageContribRecord>();
  const dataDir = join(currentHarness, "tools", "data");
  if (pathPresent(dataDir) && lstatSync(dataDir).isDirectory()) {
    for (const file of readdirSync(dataDir).filter((name) => /^plugin-contrib-.+\.json$/.test(name))) {
      if (!regularFile(join(dataDir, file))) continue;
      const parsed = JSON.parse(readFileSync(join(dataDir, file), "utf-8")) as Record<string, StageContribRecord>;
      for (const [slug, record] of Object.entries(parsed)) {
        const priorRecord = records.get(slug) ?? {};
        records.set(slug, {
          produces: [...new Set([...(priorRecord.produces ?? []), ...(record.produces ?? [])])],
          sensors: [...new Set([...(priorRecord.sensors ?? []), ...(record.sensors ?? [])])],
          consumes: [...new Set([...(priorRecord.consumes ?? []), ...(record.consumes ?? [])])],
          required_sections: [
            ...new Set([...(priorRecord.required_sections ?? []), ...(record.required_sections ?? [])]),
          ],
          required_sections_created:
            priorRecord.required_sections_created || record.required_sections_created,
        });
      }
    }
  }

  const stageRoot = join(currentHarness, "aidlc-common", "stages");
  if (pathPresent(stageRoot) && lstatSync(stageRoot).isDirectory()) {
    for (const phase of readdirSync(stageRoot)) {
      const currentPhase = join(stageRoot, phase);
      if (!lstatSync(currentPhase).isDirectory()) continue;
      for (const file of readdirSync(currentPhase).filter((name) => name.endsWith(".md"))) {
        const rel = `${descriptor.harnessDir}/aidlc-common/stages/${phase}/${file}`;
        const priorHash = prior?.files[rel];
        const currentPath = join(projectDir, rel);
        const stagedPath = join(root, rel);
        if (!regularFile(currentPath) || !existsSync(stagedPath)) continue;
        const current = readFileSync(currentPath, "utf-8");
        const record = records.get(file.slice(0, -3)) ?? {};
        const fragments = pluginFragments(current);
        const hasRecordedContribution = Object.entries(record).some(([key, value]) =>
          key === "required_sections_created" ? value === true : Array.isArray(value) && value.length > 0
        );
        if (fragments.length === 0 && !hasRecordedContribution) {
          continue;
        }
        const currentHash = sha256Bytes(current);
        const strippedHash = sha256Bytes(stripRecordedContributions(current, record));
        if (priorHash && currentHash !== priorHash && strippedHash !== priorHash) continue;
        let fresh = readFileSync(stagedPath, "utf-8");
        fresh = mergeListField(fresh, "produces", record.produces ?? []);
        fresh = mergeListField(fresh, "sensors", record.sensors ?? []);
        fresh = mergeConsumes(fresh, consumeBlocks(current, new Set(record.consumes ?? [])));
        fresh = mergeRequiredSections(fresh, record);
        fresh = mergePluginFragments(fresh, fragments);
        writeFileSync(stagedPath, fresh);
        if (prior) regenerated.add(rel);
      }
    }
  }

  const envKeys = [
    "AIDLC_RUNTIME_PROJECT_DIR",
    "AIDLC_PROJECT_DIR",
    "AIDLC_HARNESS_DIR",
    "AIDLC_RUNTIME_HARNESS_ROOT",
    "AIDLC_RULES_DIR",
    "AIDLC_STAGE_GRAPH",
    "AIDLC_SCOPE_GRID",
    "AIDLC_SCOPES_DIR",
    "AIDLC_SENSORS_DIR",
    "AIDLC_AGENTS_DIR",
  ] as const;
  const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  try {
    process.env.AIDLC_RUNTIME_PROJECT_DIR = root;
    process.env.AIDLC_PROJECT_DIR = root;
    process.env.AIDLC_HARNESS_DIR = descriptor.harnessDir;
    process.env.AIDLC_RUNTIME_HARNESS_ROOT = stagedHarness;
    process.env.AIDLC_RULES_DIR = join(root, "aidlc", "spaces", "default", "memory");
    process.env.AIDLC_STAGE_GRAPH = join(stagedHarness, "tools", "data", "stage-graph.json");
    process.env.AIDLC_SCOPE_GRID = stagedGrid;
    process.env.AIDLC_SCOPES_DIR = join(stagedHarness, "scopes");
    process.env.AIDLC_SENSORS_DIR = join(stagedHarness, "sensors");
    process.env.AIDLC_AGENTS_DIR = join(stagedHarness, "agents");
    resetProjectionCaches();
    const compiled = compileStageGraph();
    writeFileSync(process.env.AIDLC_STAGE_GRAPH, compiled.json);
    writeFileSync(stagedGrid, compiled.gridJson);
    resetProjectionCaches();
    regenerateRunnerSurfaces();
    resetProjectionCaches();

    const skillPath = existsSync(join(stagedHarness, "skills", "aidlc", "SKILL.md"))
      ? join(stagedHarness, "skills", "aidlc", "SKILL.md")
      : join(root, ".agents", "skills", "aidlc", "SKILL.md");
    if (existsSync(skillPath)) {
      let generated = readFileSync(skillPath, "utf-8");
      generated = replaceGeneratedRegion(
        generated,
        canonicalStageTableRegion(renderStageTable()),
        "stage",
      );
      generated = replaceGeneratedRegion(
        generated,
        canonicalScopeTableRegion(renderScopeTable()),
        "scope",
      );
      writeFileSync(skillPath, generated);
    }
    regenerated.add(`${descriptor.harnessDir}/tools/data/stage-graph.json`);
    for (const directory of [join(stagedHarness, "skills"), join(root, ".agents", "skills")]) {
      if (!existsSync(directory)) continue;
      for (const nested of walkFiles(directory)) {
        const path = join(directory, nested);
        if (readFileSync(path, "utf-8").includes("generated-by: aidlc-runner-gen")) {
          regenerated.add(relative(root, path).replaceAll("\\", "/"));
        }
      }
    }
  } finally {
    for (const key of envKeys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetProjectionCaches();
  }
  return { root, cleanup, regenerated };
  } catch (error) {
    rmSync(cleanup, { recursive: true, force: true });
    throw error;
  }
}

function activeWorkflowDescriptions(projectDir: string): string[] {
  const active: string[] = [];
  for (const space of listSpaces(projectDir)) {
    for (const intent of listIntents(projectDir, space.name)) {
      if (intent.status === "complete" || !intent.dirName) continue;
      const path = stateFilePath(projectDir, intent.dirName, space.name);
      if (regularFile(path)) {
        const status = getField(readFileSync(path, "utf-8"), "Status");
        if (status === "Completed") continue;
      }
      active.push(`${space.name}/${intent.dirName}`);
    }
  }
  return active;
}

function assertRefreshSafe(projectDir: string): void {
  const activeWorkflows = activeWorkflowDescriptions(projectDir);
  if (activeWorkflows.length === 0) return;
  throw new Error(
    `refusing to refresh while ${activeWorkflows.length} workflow(s) are active: ${
      activeWorkflows.join(", ")
    }. Complete the workflow before rerunning aidlc config; update and use do not modify project files.`,
  );
}

function blockMarkers(path: string, identity: string): { begin: string; end: string } {
  return path.endsWith(".md")
    ? {
        begin: `<!-- BEGIN AI-DLC:${identity} -->`,
        end: `<!-- END AI-DLC:${identity} -->`,
      }
    : {
        begin: `# BEGIN AI-DLC:${identity}`,
        end: `# END AI-DLC:${identity}`,
      };
}

function mergeBlock(
  path: string,
  current: string,
  shipped: string,
  identity: string,
  legacyWholeFileHashes: readonly string[] = [],
): {
  value?: string;
  currentHash?: string;
  nextHash?: string;
  adoptedLegacy?: boolean;
  error?: string;
} {
  const { begin, end } = blockMarkers(path, identity);
  const begins = current.split(begin).length - 1;
  const ends = current.split(end).length - 1;
  if (begins > 1 || ends > 1 || (begins === 1) !== (ends === 1)) {
    return { error: "managed markers are missing, duplicated, or malformed" };
  }
  const beginAt = current.indexOf(begin);
  const endAt = current.indexOf(end);
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  const body = shipped.trim().replace(/\r?\n/g, newline);
  const block = `${begin}${newline}${body}${newline}${end}`;
  if (beginAt >= 0) {
    if (endAt < beginAt) return { error: "managed end marker precedes its begin marker" };
    const currentBlock = current.slice(beginAt, endAt + end.length);
    return {
      value: `${current.slice(0, beginAt)}${block}${current.slice(endAt + end.length)}`,
      currentHash: sha256Bytes(currentBlock),
      nextHash: sha256Bytes(block),
    };
  }
  if (current.length > 0 && legacyWholeFileHashes.includes(sha256Bytes(current))) {
    return {
      value: `${block}${newline}`,
      nextHash: sha256Bytes(block),
      adoptedLegacy: true,
    };
  }
  if (/\baidlc\b|AI-DLC/i.test(current)) {
    return { error: "legacy root integration ambiguous; move or delete the unmarked AI-DLC content" };
  }
  const prefix = current.length === 0 || current.endsWith(newline) ? current : `${current}${newline}`;
  return {
    value: `${prefix}${prefix ? newline : ""}${block}${newline}`,
    nextHash: sha256Bytes(block),
  };
}

function installedSources(requiredVersion?: string): string[] {
  const roots: string[] = [];
  const explicit = process.env.AIDLC_RUNTIME_ROOT;
  if (explicit && existsSync(explicit)) {
    for (const entry of readdirSync(explicit).sort()) {
      const candidate = join(explicit, entry);
      if (statSync(candidate).isDirectory()) roots.push(candidate);
    }
    try {
      projectionFiles(explicit);
      roots.push(explicit);
    } catch {
      // The explicit root may be a parent of distributions.
    }
  }
  const active = activeVersion();
  if (active) {
    const root = runtimeRoot(active);
    if (existsSync(root)) {
      for (const entry of readdirSync(root).sort()) {
        const candidate = join(root, entry);
        if (statSync(candidate).isDirectory()) roots.push(candidate);
      }
    }
  }
  if (requiredVersion && requiredVersion !== active) {
    const root = runtimeRoot(requiredVersion);
    if (existsSync(root)) {
      for (const entry of readdirSync(root).sort()) {
        const candidate = join(root, entry);
        if (statSync(candidate).isDirectory()) roots.push(candidate);
      }
    }
  }
  const executableRuntime = join(dirname(process.execPath), "runtime");
  if (existsSync(executableRuntime)) {
    for (const entry of readdirSync(executableRuntime).sort()) {
      const candidate = join(executableRuntime, entry);
      if (statSync(candidate).isDirectory()) roots.push(candidate);
    }
  }
  return [...new Set(roots)];
}

function materializeSource(path: string): { root: string; cleanup?: string } {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (!existsSync(absolute)) throw new Error(`init source does not exist: ${absolute}`);
  if (statSync(absolute).isDirectory()) return { root: absolute };
  const temporary = mkdtempSync(join(tmpdir(), "aidlc-init-source-"));
  extractTarGz(absolute, temporary);
  return { root: temporary, cleanup: temporary };
}

function configuredDefaultHarness(): string | undefined {
  const path = defaultHarnessPath();
  if (!existsSync(path)) return undefined;
  const value = readFileSync(path, "utf-8").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new Error(
      `${path} contains an invalid harness name; pass --harness <name>`,
    );
  }
  return value;
}

function selectSource(
  requested: string | undefined,
  from: string | undefined,
  existingDistribution: string | undefined,
  requiredVersion?: string,
): { root: string; cleanup?: string } {
  if (from) {
    const source = materializeSource(from);
    const { stamp } = projectionFiles(source.root);
    if (requested && stamp.distribution !== requested) {
      if (source.cleanup) rmSync(source.cleanup, { recursive: true, force: true });
      throw new Error(`source is ${stamp.distribution}, not requested harness ${requested}`);
    }
    if (existingDistribution && stamp.distribution !== existingDistribution) {
      if (source.cleanup) rmSync(source.cleanup, { recursive: true, force: true });
      throw new Error(`existing project uses ${existingDistribution}; refusing ${stamp.distribution}`);
    }
    return source;
  }
  const candidates = installedSources(requiredVersion).flatMap((root) => {
    try {
      const projection = projectionFiles(root);
      return [{ root, stamp: projection.stamp, descriptor: projection.descriptor }];
    } catch {
      return [];
    }
  });
  const selectedName = existingDistribution || requested;
  const versionFiltered = requiredVersion
    ? candidates.filter((candidate) =>
        candidate.stamp.frameworkVersion === requiredVersion
      )
    : candidates;
  if (selectedName) {
    const selected = versionFiltered.filter((candidate) =>
      candidate.stamp.distribution === selectedName
    );
    if (selected.length === 1) return { root: selected[0].root };
    throw new Error(
      requiredVersion && versionFiltered.length === 0
        ? `project requires ${requiredVersion}, which is not installed; run aidlc config --pin ${requiredVersion}`
        : requiredVersion
        ? `harness ${selectedName} is not installed in ${requiredVersion}; run aidlc config --pin ${requiredVersion}`
        : `harness ${selectedName} is not installed`,
    );
  }
  const configuredDefault = configuredDefaultHarness();
  if (configuredDefault) {
    const selected = versionFiltered.filter((candidate) =>
      candidate.stamp.distribution === configuredDefault
    );
    if (selected.length === 1) return { root: selected[0].root };
    if (versionFiltered.length > 0) {
      throw new Error(
        requiredVersion
          ? `configured default harness ${configuredDefault} is not installed in ${requiredVersion}; run aidlc config --pin ${requiredVersion}`
          : `configured default harness ${configuredDefault} is unavailable; pass --harness <name>`,
      );
    }
  }
  if (versionFiltered.length === 1) return { root: versionFiltered[0].root };
  if (versionFiltered.length === 0) {
    throw new Error(
      requiredVersion
        ? `project requires ${requiredVersion}, which is not installed; run aidlc config --pin ${requiredVersion}`
        : "no installed harness runtime is available",
    );
  }
  if (process.stdin.isTTY) {
    process.stdout.write("Select a harness for this project:\n");
    for (const [index, candidate] of versionFiltered.entries()) {
      process.stdout.write(
        `  ${index + 1}) ${candidate.stamp.distribution} - ${candidate.descriptor.productName}\n`,
      );
    }
    const answer = prompt(`Harness [1-${versionFiltered.length}]:`);
    const selected = answer && /^\d+$/.test(answer)
      ? versionFiltered[Number(answer) - 1]
      : undefined;
    if (selected) return { root: selected.root };
    throw new Error("harness selection cancelled; pass --harness <name>");
  }
  throw new Error(
    `multiple harnesses are installed; pass --harness <${
      versionFiltered.map((item) => item.stamp.distribution).join("|")
    }>`,
  );
}

function existingProject(projectDir: string, requested?: string): {
  distribution?: string;
  baseline?: Baseline;
} {
  const harnesses = discoverProjectHarnesses(projectDir);
  const harness = requested
    ? harnesses.find((candidate) => candidate.distribution === requested)
    : harnesses[0];
  if (!harness && requested && harnesses.length > 0) {
    throw new Error(
      `project uses ${harnesses.map((candidate) => candidate.distribution).join(", ")}; refusing ${requested}`,
    );
  }
  if (!harness) return {};
  const baselinePath = join(harness.root, "tools", "data", "aidlc-manifest.json");
  const baseline = readBaseline(baselinePath);
  if (
    baseline &&
    (
      baseline.distribution !== harness.distribution ||
      baseline.harnessDir !== harness.harnessDir
    )
  ) {
    throw new Error(`${baselinePath}: baseline identity does not match the installed harness`);
  }
  return {
    distribution: harness.distribution,
    ...(baseline ? { baseline } : {}),
  };
}

function planManagedFiles(
  projectDir: string,
  sourceRoot: string,
  descriptor: ProjectionDescriptor,
  prior: Baseline | null,
  force: boolean,
  operations: TransactionOperation[],
  actions: PlannedAction[],
  nextHashes: Record<string, string>,
  regenerated: ReadonlySet<string>,
): void {
  const shipped = new Set<string>();
  for (const directory of descriptor.managedDirectories) {
    const sourceDir = join(sourceRoot, directory);
    if (!existsSync(sourceDir)) throw new Error(`projection is missing managed directory ${directory}`);
    for (const nested of walkFiles(sourceDir)) {
      const rel = join(directory, nested).replaceAll("\\", "/");
      shipped.add(rel);
      const source = join(sourceRoot, rel);
      const target = join(projectDir, rel);
      const targetExists = pathPresent(target);
      const targetRegular = targetExists && lstatSync(target).isFile();
      const hash = sha256File(source);
      const adoptedManagedFile = prior === null &&
        targetRegular &&
        (
          descriptor.legacyManagedFileHashes?.[rel]?.includes(
            sha256File(target),
          ) ?? false
        );
      const seedOnly = rel === "aidlc/active-space" ||
        (rel.startsWith("aidlc/spaces/") && rel.includes("/memory/"));
      if (seedOnly) {
        if (targetExists) {
          actions.push({ path: rel, action: "preserve", detail: "project-owned seed" });
        } else {
          operations.push({
            kind: "copy",
            path: rel,
            source,
            sourceHash: hash,
            expected: "absent",
            mode: statSync(source).mode & 0o777,
          });
          actions.push({ path: rel, action: "create" });
        }
        continue;
      }
      if (runtimeGenerated(rel, descriptor.harnessDir, regenerated)) {
        if (
          ![
            `${descriptor.harnessDir}/tools/data/harness.json`,
            `${descriptor.harnessDir}/tools/data/stage-graph.json`,
            `${descriptor.harnessDir}/tools/data/scope-grid.json`,
          ].includes(rel)
        ) {
          nextHashes[rel] = hash;
        }
        if (targetRegular && sha256File(target) === hash) {
          actions.push({ path: rel, action: "preserve", detail: "runtime-generated" });
          continue;
        }
        if (targetExists && !targetRegular && !force) {
          actions.push({ path: rel, action: "conflict", detail: "managed path is not a regular file" });
          continue;
        }
        operations.push({
          kind: "copy",
          path: rel,
          source,
          sourceHash: hash,
          expected: expected(target),
          mode: statSync(source).mode & 0o777,
        });
        actions.push({
          path: rel,
          action: targetExists ? "update" : "create",
          detail: "runtime-generated",
        });
        continue;
      }
      nextHashes[rel] = hash;
      if (targetRegular && sha256File(target) === hash) {
        actions.push({ path: rel, action: "preserve" });
        continue;
      }
      const priorHash = prior?.files[rel];
      if (
        targetExists &&
        (
          !targetRegular ||
          (!adoptedManagedFile && (!priorHash || sha256File(target) !== priorHash))
        ) &&
        !force
      ) {
        actions.push({ path: rel, action: "conflict", detail: "locally modified or unowned" });
        continue;
      }
      operations.push({
        kind: "copy",
        path: rel,
        source,
        sourceHash: hash,
        expected: expected(target),
        mode: statSync(source).mode & 0o777,
      });
      actions.push({
        path: rel,
        action: targetExists ? "update" : "create",
        detail: adoptedManagedFile ? "adopted exact copy-channel signature" : undefined,
      });
    }
  }
  for (const [rel, priorHash] of Object.entries(prior?.files ?? {})) {
    if (shipped.has(rel) || rel.endsWith("/tools/data/aidlc-manifest.json")) continue;
    const target = join(projectDir, rel);
    if (!pathPresent(target)) continue;
    if ((!regularFile(target) || sha256File(target) !== priorHash) && !force) {
      actions.push({ path: rel, action: "conflict", detail: "removed upstream but locally modified" });
      continue;
    }
    operations.push({ kind: "remove", path: rel, expected: expected(target) });
    actions.push({ path: rel, action: "remove" });
  }
}

function planRootIntegrations(
  projectDir: string,
  sourceRoot: string,
  descriptor: ProjectionDescriptor,
  prior: Baseline | null,
  mcpMode: "defaults" | "none",
  force: boolean,
  operations: TransactionOperation[],
  actions: PlannedAction[],
  contributions: Record<string, RootContribution>,
): void {
  for (const integration of descriptor.rootIntegrations) {
    const sourcePath = join(sourceRoot, integration.path);
    const targetPath = join(projectDir, integration.path);
    const targetExists = pathPresent(targetPath);
    const targetRegular = targetExists && lstatSync(targetPath).isFile();
    if (targetExists && !targetRegular && !force) {
      actions.push({
        path: integration.path,
        action: "conflict",
        detail: "root integration is not a regular file",
      });
      continue;
    }
    const current = targetRegular ? readFileSync(targetPath, "utf-8") : "";
    const priorContribution = prior?.rootContributions[integration.path];
    if (integration.policy === "managed-block") {
      const merged = mergeBlock(
        integration.path,
        current,
        readFileSync(sourcePath, "utf-8"),
        integration.marker || basename(integration.path),
        integration.legacySignatures?.wholeFileHashes,
      );
      if (merged.error) {
        actions.push({ path: integration.path, action: "conflict", detail: merged.error });
        continue;
      }
      const value = merged.value as string;
      const priorHash = priorContribution?.policy === "managed-block"
        ? priorContribution.hash
        : undefined;
      if (
        merged.currentHash &&
        merged.currentHash !== merged.nextHash &&
        merged.currentHash !== priorHash &&
        !force
      ) {
        actions.push({
          path: integration.path,
          action: "conflict",
          detail: priorHash ? "managed block was locally modified" : "managed block has no ownership baseline",
        });
        continue;
      }
      contributions[integration.path] = {
        policy: "managed-block",
        hash: merged.nextHash as string,
        marker: integration.marker,
      };
      if (value === current) {
        actions.push({ path: integration.path, action: "preserve" });
      } else {
        operations.push(writeOperation(integration.path, value, expected(targetPath)));
        actions.push({
          path: integration.path,
          action: targetExists ? "merge" : "create",
          detail: merged.adoptedLegacy ? "adopted exact legacy signature" : undefined,
        });
      }
      continue;
    }
    if (integration.policy === "json-map") {
      let targetValue: unknown;
      let sourceValue: unknown;
      try {
        targetValue = current ? JSON.parse(current) : {};
        sourceValue = JSON.parse(readFileSync(sourcePath, "utf-8"));
      } catch {
        actions.push({ path: integration.path, action: "conflict", detail: "malformed JSON" });
        continue;
      }
      if (!isRecord(targetValue) || !isRecord(sourceValue)) {
        actions.push({ path: integration.path, action: "conflict", detail: "JSON root must be an object" });
        continue;
      }
      const target = targetValue;
      const source = sourceValue;
      const key = integration.jsonKey as string;
      const rawTargetMap = target[key] ?? {};
      const rawSourceMap = source[key] ?? {};
      if (!isRecord(rawTargetMap) || !isRecord(rawSourceMap)) {
        actions.push({
          path: integration.path,
          action: "conflict",
          detail: `${key} must be a JSON object`,
        });
        continue;
      }
      const targetMap = { ...rawTargetMap };
      const sourceMap = rawSourceMap;
      const priorEntries = priorContribution?.policy === "json-map"
        ? priorContribution.entries
        : {};
      const nextEntries: Record<string, string> = {};
      if (!current && integration.optional && mcpMode === "none") {
        contributions[integration.path] = {
          policy: "json-map",
          entries: {},
          key: integration.jsonKey,
        };
        actions.push({ path: integration.path, action: "preserve", detail: "optional integration disabled" });
        continue;
      }
      if (mcpMode === "defaults") {
        for (const [entry, value] of Object.entries(sourceMap)) {
          const desiredHash = sha256Bytes(canonical(value));
          if (!(entry in targetMap)) {
            targetMap[entry] = value;
            nextEntries[entry] = desiredHash;
            continue;
          }
          const currentHash = sha256Bytes(canonical(targetMap[entry]));
          const priorHash = priorEntries[entry];
          if (priorHash && (currentHash === priorHash || force)) {
            targetMap[entry] = value;
            nextEntries[entry] = desiredHash;
          } else if (priorHash && currentHash === desiredHash) {
            nextEntries[entry] = desiredHash;
          } else if (
            !priorHash &&
            (integration.legacySignatures?.jsonEntryHashes?.[entry] ?? []).includes(currentHash)
          ) {
            targetMap[entry] = value;
            nextEntries[entry] = desiredHash;
          }
        }
        for (const [entry, priorHash] of Object.entries(priorEntries)) {
          if (entry in sourceMap || !(entry in targetMap)) continue;
          const currentHash = sha256Bytes(canonical(targetMap[entry]));
          if (currentHash === priorHash || force) delete targetMap[entry];
        }
      } else {
        for (const [entry, priorHash] of Object.entries(priorEntries)) {
          if (!(entry in targetMap)) continue;
          const currentHash = sha256Bytes(canonical(targetMap[entry]));
          if (currentHash === priorHash || force) {
            delete targetMap[entry];
          }
        }
      }
      if (Object.keys(targetMap).length > 0) target[key] = targetMap;
      else delete target[key];
      contributions[integration.path] = {
        policy: "json-map",
        entries: nextEntries,
        key: integration.jsonKey,
      };
      const semanticChanged = canonical(targetValue) !== canonical(current ? JSON.parse(current) : {});
      if (!semanticChanged) {
        actions.push({ path: integration.path, action: "preserve" });
      } else {
        const value = `${JSON.stringify(target, null, 2)}\n`;
        operations.push(writeOperation(integration.path, value, expected(targetPath)));
        actions.push({ path: integration.path, action: targetExists ? "merge" : "create" });
      }
      continue;
    }
    if (integration.policy === "json-array") {
      let targetValue: unknown;
      let sourceValue: unknown;
      try {
        targetValue = current ? JSON.parse(current) : {};
        sourceValue = JSON.parse(readFileSync(sourcePath, "utf-8"));
      } catch {
        actions.push({ path: integration.path, action: "conflict", detail: "malformed JSON" });
        continue;
      }
      if (!isRecord(targetValue) || !isRecord(sourceValue)) {
        actions.push({ path: integration.path, action: "conflict", detail: "JSON root must be an object" });
        continue;
      }
      const key = integration.jsonKey as string;
      const targetArray = targetValue[key] ?? [];
      const sourceArray = sourceValue[key] ?? [];
      if (
        !Array.isArray(targetArray) ||
        !Array.isArray(sourceArray) ||
        !targetArray.every((item) => typeof item === "string") ||
        !sourceArray.every((item) => typeof item === "string")
      ) {
        actions.push({ path: integration.path, action: "conflict", detail: `${key} must be a string array` });
        continue;
      }
      const priorEntries = priorContribution?.policy === "json-array"
        ? priorContribution.entries
        : {};
      const desired = new Map(
        sourceArray.map((item) => [item, sha256Bytes(canonical(item))]),
      );
      const nextEntries: Record<string, string> = {};
      const retained = targetArray.filter((item) => {
        const priorHash = priorEntries[item];
        if (priorHash && desired.has(item)) nextEntries[item] = desired.get(item) as string;
        return !priorHash || desired.has(item) || sha256Bytes(canonical(item)) !== priorHash;
      });
      for (const item of sourceArray) {
        if (!retained.includes(item)) {
          retained.push(item);
          nextEntries[item] = desired.get(item) as string;
        }
      }
      if (retained.length > 0) targetValue[key] = retained;
      else delete targetValue[key];
      contributions[integration.path] = {
        policy: "json-array",
        entries: nextEntries,
        key,
      };
      const semanticChanged = canonical(targetValue) !== canonical(current ? JSON.parse(current) : {});
      if (!semanticChanged) {
        actions.push({ path: integration.path, action: "preserve" });
      } else {
        operations.push(writeOperation(
          integration.path,
          `${JSON.stringify(targetValue, null, 2)}\n`,
          expected(targetPath),
        ));
        actions.push({ path: integration.path, action: targetExists ? "merge" : "create" });
      }
      continue;
    }
    const shipped = readFileSync(sourcePath);
    const shippedHash = sha256Bytes(shipped);
    const priorHash = priorContribution?.policy === "whole-file"
      ? priorContribution.hash
      : undefined;
    const currentHash = sha256Bytes(current);
    const adoptedLegacy = integration.legacySignatures?.wholeFileHashes?.includes(currentHash) ?? false;
    contributions[integration.path] = { policy: "whole-file", hash: shippedHash };
    if (
      targetExists &&
      currentHash !== priorHash &&
      currentHash !== shippedHash &&
      !adoptedLegacy
    ) {
      actions.push({ path: integration.path, action: "conflict", detail: "unowned whole file" });
    } else if (currentHash === shippedHash) {
      actions.push({ path: integration.path, action: "preserve" });
    } else {
      operations.push(writeOperation(integration.path, shipped, expected(targetPath)));
      actions.push({
        path: integration.path,
        action: targetExists ? "update" : "create",
        detail: adoptedLegacy ? "adopted exact legacy signature" : undefined,
      });
    }
  }
}

function planRemovedRootIntegrations(
  projectDir: string,
  descriptor: ProjectionDescriptor,
  prior: Baseline | null,
  force: boolean,
  operations: TransactionOperation[],
  actions: PlannedAction[],
): void {
  const current = new Set(descriptor.rootIntegrations.map((item) => item.path));
  for (const [path, contribution] of Object.entries(prior?.rootContributions ?? {})) {
    if (current.has(path)) continue;
    const targetPath = join(projectDir, path);
    if (!pathPresent(targetPath)) continue;
    if (!regularFile(targetPath)) {
      if (!force) {
        actions.push({ path, action: "conflict", detail: "retired root integration is not a regular file" });
        continue;
      }
      operations.push({ kind: "remove", path, expected: expected(targetPath) });
      actions.push({ path, action: "remove" });
      continue;
    }
    const text = readFileSync(targetPath, "utf-8");
    if (contribution.policy === "managed-block") {
      const fallback = basename(path).replace(/\.[^.]+$/, "").toLowerCase();
      const { begin, end } = blockMarkers(path, contribution.marker ?? fallback);
      const beginAt = text.indexOf(begin);
      const endAt = text.indexOf(end, beginAt + begin.length);
      if (beginAt < 0 || endAt < beginAt) {
        actions.push({ path, action: "conflict", detail: "retired managed block markers are missing" });
        continue;
      }
      const blockEnd = endAt + end.length;
      if (sha256Bytes(text.slice(beginAt, blockEnd)) !== contribution.hash && !force) {
        actions.push({ path, action: "conflict", detail: "retired managed block was locally modified" });
        continue;
      }
      let value = `${text.slice(0, beginAt)}${text.slice(blockEnd)}`;
      value = value.replace(/^\r?\n/, "").replace(/\r?\n\r?\n$/, "\n");
      if (!value) {
        operations.push({ kind: "remove", path, expected: expected(targetPath) });
        actions.push({ path, action: "remove" });
      } else {
        operations.push(writeOperation(path, value, expected(targetPath)));
        actions.push({ path, action: "merge", detail: "removed retired managed block" });
      }
      continue;
    }
    if (contribution.policy === "json-map") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        actions.push({ path, action: "conflict", detail: "retired JSON integration is malformed" });
        continue;
      }
      if (!isRecord(parsed)) {
        actions.push({ path, action: "conflict", detail: "retired JSON integration root is not an object" });
        continue;
      }
      const maps = contribution.key && isRecord(parsed[contribution.key])
        ? [parsed[contribution.key] as Record<string, unknown>]
        : Object.values(parsed).filter(isRecord);
      let conflict = false;
      for (const [entry, priorHash] of Object.entries(contribution.entries)) {
        for (const map of maps) {
          if (!(entry in map)) continue;
          if (sha256Bytes(canonical(map[entry])) !== priorHash && !force) conflict = true;
          else delete map[entry];
        }
      }
      if (conflict) {
        actions.push({ path, action: "conflict", detail: "retired JSON entry was locally modified" });
        continue;
      }
      operations.push(writeOperation(path, `${JSON.stringify(parsed, null, 2)}\n`, expected(targetPath)));
      actions.push({ path, action: "merge", detail: "removed retired JSON entries" });
      continue;
    }
    if (contribution.policy === "json-array") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        actions.push({ path, action: "conflict", detail: "retired JSON integration is malformed" });
        continue;
      }
      if (!isRecord(parsed) || !Array.isArray(parsed[contribution.key])) {
        actions.push({ path, action: "conflict", detail: "retired JSON array integration is malformed" });
        continue;
      }
      const values = parsed[contribution.key] as unknown[];
      const retired = new Set(Object.keys(contribution.entries));
      parsed[contribution.key] = values.filter((value) =>
        typeof value !== "string" || !retired.has(value) ||
        sha256Bytes(canonical(value)) !== contribution.entries[value]
      );
      if ((parsed[contribution.key] as unknown[]).length === 0) delete parsed[contribution.key];
      operations.push(writeOperation(path, `${JSON.stringify(parsed, null, 2)}\n`, expected(targetPath)));
      actions.push({ path, action: "merge", detail: "removed retired JSON array entries" });
      continue;
    }
    if (sha256File(targetPath) !== contribution.hash && !force) {
      actions.push({ path, action: "conflict", detail: "retired whole-file integration was locally modified" });
      continue;
    }
    operations.push({ kind: "remove", path, expected: expected(targetPath) });
    actions.push({ path, action: "remove" });
  }
}

function prepareModelsSection(
  argv: string[],
  options: ReturnType<typeof globalOptions>,
): { argv: string[]; context: ModelsMutationContext } | null {
  const validation = validateModelsArgs(argv);
  if (validation) {
    emitResult(usage(validation, "aidlc config models --help"), options);
    return null;
  }
  if (argv.includes("--help")) {
    process.stdout.write(`${modelPolicyHelp()}\n`);
    process.exitCode = EXIT.ok;
    return null;
  }
  const mutationFlags = [
    "--agent",
    "--deciding-effort",
    "--effort",
    "--from",
    "--model",
    "--preset",
    "--reset",
    "--reviewing-effort",
    "--save-as",
    "--writing-up-effort",
  ];
  const hasMutationFlags = mutationFlags.some((flag) => argv.includes(flag));
  if (
    (argv.includes("--show") || argv.includes("--check")) &&
    (hasMutationFlags || argv.includes("--dry-run") || argv.includes("--yes"))
  ) {
    emitResult(
      usage("--show and --check cannot be combined with model policy mutations"),
      options,
    );
    return null;
  }
  if (argv.includes("--show") && argv.includes("--check")) {
    emitResult(usage("--show and --check are mutually exclusive"), options);
    return null;
  }
  const projectDir = projectDirFrom(argv);
  const requested = valueAfter(argv, "--harness");
  const harnesses = discoverProjectHarnesses(projectDir);
  const selected = requested
    ? harnesses.find((candidate) => candidate.distribution === requested)
    : harnesses[0];
  if (!selected) {
    emitResult(
      usage(
        requested && harnesses.length > 0
          ? `project uses ${harnesses.map((item) => item.distribution).join(", ")}; refusing ${requested}`
          : "aidlc config models requires an installed project harness; run aidlc config first",
      ),
      options,
    );
    return null;
  }
  if (!requested && harnesses.length > 1) {
    emitResult(
      usage("multiple project harnesses are present; pass one --harness <name>"),
      options,
    );
    return null;
  }
  const harness = modelHarness(selected.distribution);
  const current = modelPolicyFromHarnessRoot(selected.root);
  const tiers = readAgentTiers(selected.root);
  if (argv.includes("--show")) {
    showModels(current, tiers, harness, projectDir, options);
    return null;
  }
  if (argv.includes("--check")) {
    const drift = modelPolicySurfaceDrift(
      projectDir,
      selected.harnessDir,
      harness,
    );
    emitResult(
      drift.length === 0
        ? success(`model policy is reflected on ${harness}`, {
            harness,
            drift: [],
          })
        : failure(
            `model policy drift: ${drift.join("; ")}`,
            EXIT.failure,
            "aidlc config models --show",
          ),
      options,
    );
    return null;
  }

  let next: ModelPolicyRecord | null;
  if (hasMutationFlags) {
    next = applyModelsFlags(current, argv, tiers);
  } else {
    if (!process.stdin.isTTY) {
      emitResult(
        usage(
          "non-interactive model configuration requires a policy flag: --preset, --from, a group effort flag, --agent, or --reset; --yes confirms but never chooses a policy",
          "aidlc config models --help",
        ),
        options,
      );
      return null;
    }
    next = modelsWizard(current, tiers, harness, projectDir);
  }
  if (canonical(current) === canonical(next)) {
    emitResult(success("model policy unchanged"), options);
    return null;
  }
  if (!argv.includes("--dry-run") && !options.yes) {
    if (!process.stdin.isTTY) {
      emitResult(
        usage(
          "non-interactive model policy mutation requires --yes; --yes confirms the selected policy but never chooses one",
        ),
        options,
      );
      return null;
    }
    const answer = prompt("Apply model policy changes? [y/N]:");
    if (!answer || !/^y(?:es)?$/i.test(answer.trim())) {
      emitResult(usage("model policy change cancelled"), options);
      return null;
    }
  }
  const summary = modelSummaryLines(current, next, tiers, harness, projectDir);
  return {
    argv: modelsPipelineArgv(argv),
    context: {
      harness,
      harnessDir: selected.harnessDir,
      previous: current,
      next,
      tiers,
      summaryLines: summary.lines,
      notes: summary.notes,
    },
  };
}

export async function main(input: string[]): Promise<void> {
  let argv = stripVerb(input);
  const options = globalOptions(argv);
  const positionals = configPositionals(argv);
  const section = positionals[0];
  if (section && section.value !== "models") {
    emitResult(
      usage(
        `unknown config section ${JSON.stringify(section.value)}; valid sections: models`,
        "aidlc config models --help",
      ),
      options,
    );
    return;
  }
  let modelsContext: ModelsMutationContext | null = null;
  if (section?.value === "models") {
    argv = [...argv.slice(0, section.index), ...argv.slice(section.index + 1)];
    try {
      const preparedModels = prepareModelsSection(argv, options);
      if (!preparedModels) return;
      argv = preparedModels.argv;
      modelsContext = preparedModels.context;
    } catch (error) {
      emitResult(
        usage(
          error instanceof Error ? error.message : String(error),
          "aidlc config models --help",
        ),
        options,
      );
      return;
    }
  }
  if (argv.includes("--pin") || argv.includes("--unpin")) {
    emitResult(await configureProjectPin(argv), options);
    return;
  }
  const requestedHarnesses = valuesAfter(argv, "--harness");
  const requestedHarness = requestedHarnesses[0];
  const from = valueAfter(argv, "--from");
  const mcpValue = valueAfter(argv, "--mcp");
  if (argv.includes("--harness") && !requestedHarness) {
    emitResult(usage("--harness requires a distribution name"), options);
    return;
  }
  if (requestedHarnesses.length > 1) {
    emitResult(
      usage("multi-harness config is not supported yet; pass one --harness <name>"),
      options,
    );
    return;
  }
  if (mcpValue && mcpValue !== "defaults" && mcpValue !== "none") {
    emitResult(usage("--mcp must be defaults or none"), options);
    return;
  }
  const projectDir = projectDirFrom(argv);
  const explicitProject = argv.includes("--project-dir") ||
    Boolean(process.env.AIDLC_PROJECT_DIR) ||
    Boolean(process.env.CLAUDE_PROJECT_DIR) ||
    Boolean(process.env.KIRO_PROJECT_DIR);
  const recognized = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml"]
    .some((entry) => existsSync(join(projectDir, entry)));
  if (!recognized && !explicitProject && !options.yes) {
    if (!process.stdin.isTTY) {
      emitResult(usage("non-interactive config outside a recognized project requires --project-dir"), options);
      return;
    }
    const answer = prompt(`Initialize AI-DLC in ${projectDir}? [y/N]:`);
    if (!answer || !/^y(?:es)?$/i.test(answer.trim())) {
      emitResult(usage("configuration cancelled; pass --project-dir to select the target explicitly"), options);
      return;
    }
  }
  let selected: { root: string; cleanup?: string } | null = null;
  let prepared: { root: string; cleanup?: string; regenerated: Set<string> } | null = null;
  try {
    const existing = existingProject(projectDir, requestedHarness);
    const pinPath = join(projectDir, ".aidlc-version");
    if (pathPresent(pinPath) && !regularFile(pinPath)) {
      throw new Error("project pin .aidlc-version is not a regular file");
    }
    const requiredVersion = regularFile(pinPath) ? readFileSync(pinPath, "utf-8").trim() : undefined;
    selected = selectSource(requestedHarness, from, existing.distribution, requiredVersion);
    const { stamp, descriptor } = projectionFiles(selected.root);
    if (existing.distribution && existing.distribution !== stamp.distribution) {
      throw new Error(`project uses ${existing.distribution}; refusing ${stamp.distribution}`);
    }
    if (existing.distribution) assertRefreshSafe(projectDir);
    if (regularFile(pinPath) && readFileSync(pinPath, "utf-8").trim() !== stamp.frameworkVersion) {
      throw new Error(
        `project pin requires ${readFileSync(pinPath, "utf-8").trim()}, but source is ${stamp.frameworkVersion}; run aidlc config --pin ${readFileSync(pinPath, "utf-8").trim()}`,
      );
    }
    const baselinePath = join(projectDir, descriptor.harnessDir, "tools", "data", "aidlc-manifest.json");
    const prior = readBaseline(baselinePath);
    prepared = prepareRefreshSource(
      projectDir,
      selected.root,
      descriptor,
      prior,
      modelsContext?.next,
    );
    let mcpMode = (mcpValue ?? prior?.mcpMode) as "defaults" | "none" | undefined;
    if (
      !mcpMode &&
      process.stdin.isTTY &&
      descriptor.rootIntegrations.some((integration) =>
        integration.policy === "json-map" && integration.optional
      )
    ) {
      const answer = prompt("Configure optional AI-DLC MCP servers? [y/N]:");
      mcpMode = answer && /^y(?:es)?$/i.test(answer.trim()) ? "defaults" : "none";
    }
    mcpMode ??= "none";
    const operations: TransactionOperation[] = [];
    const actions: PlannedAction[] = [];
    const files: Record<string, string> = {};
    const rootContributions: Record<string, RootContribution> = {};
    planManagedFiles(
      projectDir,
      prepared.root,
      descriptor,
      prior,
      argv.includes("--force"),
      operations,
      actions,
      files,
      prepared.regenerated,
    );
    planRootIntegrations(
      projectDir,
      prepared.root,
      descriptor,
      prior,
      mcpMode,
      argv.includes("--force"),
      operations,
      actions,
      rootContributions,
    );
    planRemovedRootIntegrations(
      projectDir,
      descriptor,
      prior,
      argv.includes("--force"),
      operations,
      actions,
    );
    const conflicts = actions.filter((action) => action.action === "conflict");
    if (conflicts.length > 0) {
      actions.sort((left, right) =>
        left.path.localeCompare(right.path) || left.action.localeCompare(right.action)
      );
      const counts = Object.fromEntries(
        ["create", "update", "merge", "preserve", "remove", "conflict"].map((name) => [
          name,
          actions.filter((item) => item.action === name).length,
        ]),
      );
      emitResult({
        ...failure(
          `${conflicts.length} config conflict(s): ${conflicts.map((item) => `${item.path} (${item.detail})`).join(", ")}`,
          EXIT.integrity,
          "aidlc config --dry-run --verbose",
        ),
        data: { projectDir, distribution: stamp.distribution, counts, actions },
      }, options);
      return;
    }
    const baseline: Baseline = {
      schemaVersion: 1,
      frameworkVersion: stamp.frameworkVersion,
      distribution: stamp.distribution,
      harnessDir: stamp.harnessDir,
      mcpMode,
      files,
      rootContributions,
    };
    const baselineRel = join(descriptor.harnessDir, "tools", "data", "aidlc-manifest.json");
    operations.push(writeOperation(
      baselineRel,
      `${JSON.stringify(baseline, null, 2)}\n`,
      expected(baselinePath),
    ));
    actions.push({ path: baselineRel, action: pathPresent(baselinePath) ? "update" : "create" });
    actions.sort((left, right) =>
      left.path.localeCompare(right.path) || left.action.localeCompare(right.action)
    );
    const counts = Object.fromEntries(
      ["create", "update", "merge", "preserve", "remove", "conflict"].map((name) => [
        name,
        actions.filter((item) => item.action === name).length,
      ]),
    );
    const plan: TransactionPlan = { schemaVersion: 1, root: projectDir, operations };
    const approvalPlan = {
      ...plan,
      operations: plan.operations.map((operation) =>
        operation.kind === "copy"
          ? {
              ...operation,
              source: {
                sha256: sha256File(operation.source),
                mode: statSync(operation.source).mode & 0o777,
              },
            }
          : operation
      ),
    };
    const planToken = sha256Bytes(canonical(approvalPlan));
    if (argv.includes("--dry-run")) {
      if (modelsContext && options.mode === "human") {
        for (const line of modelsContext.summaryLines) process.stdout.write(`${line}\n`);
        for (const note of modelsContext.notes) process.stdout.write(`  Note: ${note}\n`);
      }
      emitResult(success(
        `${modelsContext ? "model policy" : "config"} plan for ${projectDir}: ${
          Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(" ")
        }`,
        {
          projectDir,
          distribution: stamp.distribution,
          counts,
          actions,
          planToken,
          ...(modelsContext
            ? {
                models: {
                  previous: modelsContext.previous,
                  next: modelsContext.next,
                  summaries: modelsContext.summaryLines,
                  notes: modelsContext.notes,
                },
              }
            : {}),
        },
      ), options);
      return;
    }
    const approvedToken = valueAfter(argv, "--plan-token");
    if (argv.includes("--plan-token") && !approvedToken) {
      emitResult(usage("--plan-token requires the token emitted by init --dry-run"), options);
      return;
    }
    if (approvedToken && approvedToken !== planToken) {
      emitResult(failure(
        "config plan changed after approval; run aidlc config --dry-run again",
        EXIT.integrity,
        "aidlc config --dry-run --json",
      ), options);
      return;
    }
    if (existing.distribution) {
      withAuditLock(
        projectDir,
        () => {
          assertRefreshSafe(projectDir);
          executePlan(plan);
        },
        undefined,
        undefined,
        600,
      );
    } else {
      executePlan(plan);
    }
    if (modelsContext && options.mode === "human") {
      for (const line of modelsContext.summaryLines) process.stdout.write(`${line}\n`);
      for (const note of modelsContext.notes) process.stdout.write(`  Note: ${note}\n`);
    }
    emitResult(success(
      modelsContext
        ? `configured model policy for ${projectDir}`
        : `configured ${projectDir} for ${descriptor.productName} ${stamp.frameworkVersion}; next: ${descriptor.configNextStep}`,
      {
        projectDir,
        distribution: stamp.distribution,
        version: stamp.frameworkVersion,
        counts,
        actions,
        planToken,
        ...(modelsContext
          ? {
              models: {
                previous: modelsContext.previous,
                next: modelsContext.next,
                summaries: modelsContext.summaryLines,
                notes: modelsContext.notes,
              },
            }
          : {}),
      },
    ), options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitResult(failure(
      message,
      /pass (?:one )?--harness|--harness requires|multi-harness config/.test(message)
        ? EXIT.usage
        : EXIT.integrity,
      from ? "aidlc config --from <valid-release-data>" : "aidlc config --harness <name>",
    ), options);
  } finally {
    if (prepared?.cleanup) rmSync(prepared.cleanup, { recursive: true, force: true });
    if (selected?.cleanup) rmSync(selected.cleanup, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`aidlc config: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT.failure;
  });
}
