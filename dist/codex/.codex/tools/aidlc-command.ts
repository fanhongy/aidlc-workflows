export const ROUTE_NAMESPACE_DECLARATIONS = {
  public: { trustedPrefix: false },
  engine: { trustedPrefix: true },
  system: { trustedPrefix: false },
} as const;

export type RouteNamespaceName = keyof typeof ROUTE_NAMESPACE_DECLARATIONS;

const trustedNamespaces = Object.entries(ROUTE_NAMESPACE_DECLARATIONS)
  .filter(([, declaration]) => declaration.trustedPrefix)
  .map(([namespace]) => namespace as RouteNamespaceName);

if (trustedNamespaces.length !== 1) {
  throw new Error(
    `route namespace declarations must identify exactly one trusted prefix; found ${trustedNamespaces.length}`,
  );
}

export const TRUSTED_ROUTE_NAMESPACE = trustedNamespaces[0];
export const TRUSTED_COMMAND_PREFIX = `aidlc ${TRUSTED_ROUTE_NAMESPACE}`;
export const TRUSTED_COMMAND_TOKENS = ["aidlc", TRUSTED_ROUTE_NAMESPACE] as const;
export const UNTRUSTED_ROUTE_NAMESPACES = Object.keys(ROUTE_NAMESPACE_DECLARATIONS)
  .filter((namespace) =>
    namespace !== "public" && namespace !== TRUSTED_ROUTE_NAMESPACE
  ) as RouteNamespaceName[];

export function trustedCommand(suffix = ""): string {
  return suffix ? `${TRUSTED_COMMAND_PREFIX} ${suffix}` : TRUSTED_COMMAND_PREFIX;
}

export type NamespaceRouteShape = {
  namespace: string;
  group: string;
  kind: string;
  verbs: readonly string[];
};

export type NamespaceInvocation = {
  file: string;
  line: number;
  source: "aidlc" | "bun .codex/tools/aidlc.ts";
  namespace: "engine" | "system";
  noun?: string;
  verb?: string;
  command: string;
  resolves: boolean;
};

function cleanInvocationToken(token: string | undefined): string | undefined {
  return token
    ?.replace(/^[([`"']+/, "")
    .replace(/[\]),.:;\\`"']+$/, "");
}

export function namespaceInvocationResolves(
  routes: readonly NamespaceRouteShape[],
  namespace: "engine" | "system",
  noun: string | undefined,
  verb: string | undefined,
): boolean {
  if (
    !noun ||
    noun === "*" ||
    noun === ".*" ||
    noun === "--help" ||
    noun === "-h" ||
    noun.includes("<") ||
    noun.startsWith("$")
  ) {
    return true;
  }
  const namespaceRoutes = routes.filter((route) => route.namespace === namespace);
  if (
    namespaceRoutes.some((route) =>
      route.group === "top" && route.verbs.includes(noun)
    )
  ) {
    return true;
  }
  const grouped = namespaceRoutes.filter((route) => route.group === noun);
  if (grouped.length === 0) return false;
  if (!verb) return true;
  if (verb.startsWith("<") || verb.startsWith("$")) return true;
  if (verb.startsWith("--")) {
    return grouped.some((route) => route.kind === "routing-only");
  }
  return grouped.some((route) =>
    route.kind === "routing-only" ||
    route.verbs.some((candidate) =>
      candidate === verb ||
      candidate.startsWith(`${verb} `) ||
      candidate.startsWith("<")
    )
  );
}

export function scanNamespaceInvocations(
  file: string,
  value: string,
  routes: readonly NamespaceRouteShape[],
): NamespaceInvocation[] {
  const invocations: NamespaceInvocation[] = [];
  for (const [index, line] of value.split(/\r?\n/).entries()) {
    const invocation =
      /(\baidlc|\{\{INVOKE\}\})\s+(engine|system)(?:\s+([^\s`"'|;&(){}]+))?(?:\s+([^\s`"'|;&(){}]+))?/g;
    for (const match of line.matchAll(invocation)) {
      const source = match[1] === "aidlc" ? "aidlc" : "bun .codex/tools/aidlc.ts";
      const namespace = match[2] as "engine" | "system";
      const noun = cleanInvocationToken(match[3]);
      const verb = cleanInvocationToken(match[4]);
      invocations.push({
        file,
        line: index + 1,
        source,
        namespace,
        noun,
        verb,
        command: [source, namespace, noun, verb].filter(Boolean).join(" "),
        resolves: namespaceInvocationResolves(routes, namespace, noun, verb),
      });
    }
  }
  return invocations;
}

export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  unavailable: 3,
  integrity: 4,
  actionNeeded: 5,
} as const;

export type OutputMode = "human" | "quiet" | "json";

export type CommandResult = {
  ok: boolean;
  code: number;
  status: string;
  message: string;
  data?: unknown;
  remediation?: string;
};

export type GlobalOptions = {
  mode: OutputMode;
  color: boolean;
  yes: boolean;
  offline: boolean;
  verbose: boolean;
};

export function globalOptions(argv: readonly string[]): GlobalOptions {
  return {
    mode: argv.includes("--json") ? "json" : argv.includes("--quiet") ? "quiet" : "human",
    color: !argv.includes("--no-color") && !process.env.NO_COLOR,
    yes: argv.includes("--yes"),
    offline: argv.includes("--offline") || process.env.AIDLC_OFFLINE === "1",
    verbose: argv.includes("--verbose"),
  };
}

export function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

export function valuesAfter(argv: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      values.push(argv[++i]);
    }
  }
  return values;
}

export function emitResult(result: CommandResult, options: GlobalOptions): void {
  if (options.mode === "json") {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...result })}\n`);
  } else if (options.mode === "quiet") {
    const output = result.ok ? result.message : (result.remediation ?? result.message);
    if (output) process.stdout.write(`${output}\n`);
  } else {
    const label = result.code === EXIT.actionNeeded
      ? "ACTION"
      : result.ok
      ? "PASS"
      : result.code === EXIT.integrity
      ? "FAIL"
      : "ERROR";
    process.stdout.write(`${label} ${result.message}\n`);
    if (result.remediation) process.stdout.write(`Run: ${result.remediation}\n`);
  }
  process.exitCode = result.code;
}

export function usage(message: string, remediation?: string): CommandResult {
  return { ok: false, code: EXIT.usage, status: "usage", message, remediation };
}

export function failure(
  message: string,
  code: number = EXIT.failure,
  remediation?: string,
): CommandResult {
  return { ok: false, code, status: "failed", message, remediation };
}

export function success(message: string, data?: unknown): CommandResult {
  return { ok: true, code: EXIT.ok, status: "ok", message, data };
}
