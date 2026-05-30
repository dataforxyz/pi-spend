import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	parseSessionTokenFile,
	parseSessionTokens,
	scanAgentSpend,
	scanForkRuns,
	scanObservationalMemorySpend,
	sumRunTokens,
	type AgentSpendSummary,
	type ForkRun,
	type ForkSource,
	type ForkSummary,
	type ObservationalMemorySpendSummary,
	type TokenUsage,
} from "./monitor.ts";
import { cyan, formatSpend, formatTokens, green, orange, violet } from "./formatting.ts";

const STATUS_KEY = "pi-spend";
const REFRESH_MS = 10_000;
const FORK_SPEND_SOURCES: ForkSource[] = ["intercom", "return_on"];

let latestCtx: ExtensionContext | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
let lastStatus: string | undefined;
let lastStatusAt = 0;
let lastScopeKey: string | undefined;

const modelConfigCache = new Map<string, { mtimeMs?: number; size?: number; value?: { provider: string; id: string } }>();
let memorySpendCache: { length: number; lastEntry?: unknown; value: ObservationalMemorySpendSummary } | undefined;

type SpendSnapshot = {
	threadTokens?: TokenUsage;
	agentSpend: AgentSpendSummary;
	forkSummary: ForkSummary;
	memorySpend: ObservationalMemorySpendSummary;
	memoryPricingModel?: string;
};

type SessionScope = {
	parentSessionFile?: string;
	parentSessionId?: string;
	parentSessionName?: string;
	cwd?: string;
};

function emptyTokens(): TokenUsage {
	return { input: 0, output: 0, total: 0 };
}

function fileInsideDir(file: string | undefined, dir: string | undefined): boolean {
	if (!file || !dir) return false;
	const normalizedDir = dir.endsWith("/") ? dir : `${dir}/`;
	return file === dir || file.startsWith(normalizedDir);
}

function runMatchesCurrentSession(run: ForkRun, scope: SessionScope): boolean {
	if (scope.parentSessionFile && run.parentSessionFile === scope.parentSessionFile) return true;
	if (scope.parentSessionId && (run.parentSessionId === scope.parentSessionId || run.parentIntercomTarget === scope.parentSessionId)) return true;
	if (scope.parentSessionName && (run.parentSessionName === scope.parentSessionName || run.parentIntercomTarget === scope.parentSessionName)) return true;
	if (fileInsideDir(scope.parentSessionFile, run.sessionDir)) return true;
	return false;
}

function rebuildForkSummary(runs: ForkRun[]): ForkSummary {
	const running = runs.filter((run) => run.status === "running" || run.status === "starting");
	const stale = runs.filter((run) => run.status === "stale");
	const countsByStatus: ForkSummary["countsByStatus"] = { starting: 0, running: 0, complete: 0, failed: 0, stale: 0, unknown: 0 };
	for (const run of runs) countsByStatus[run.status] += 1;
	const totalTokens = sumRunTokens(runs);
	const maxRunningDurationMs = running.reduce((max, run) => Math.max(max, run.durationMs ?? 0), 0);
	return { runs, running, stale, countsByStatus, totalTokens, maxRunningDurationMs };
}

function sessionScope(ctx?: ExtensionContext): SessionScope {
	return {
		...(ctx?.sessionManager.getSessionFile() ? { parentSessionFile: ctx.sessionManager.getSessionFile() } : {}),
		...(ctx?.sessionManager.getSessionId() ? { parentSessionId: ctx.sessionManager.getSessionId() } : {}),
		...(ctx?.sessionManager.getSessionName() ? { parentSessionName: ctx.sessionManager.getSessionName() } : {}),
		...(ctx?.cwd ? { cwd: ctx.cwd } : {}),
	};
}

function scopeKey(scope: SessionScope): string {
	return JSON.stringify(scope);
}

function relatedForkSummary(scope: SessionScope): ForkSummary {
	const scanned = scanForkRuns({ includeCompleted: true, includeTokens: false, source: FORK_SPEND_SOURCES });
	const related = scanned.runs.filter((run) => runMatchesCurrentSession(run, scope));
	for (const run of related) {
		const sinceMs = run.startedAt !== undefined ? Math.max(0, run.startedAt - 1_000) : undefined;
		const tokens = parseSessionTokens(run.sessionDir, sinceMs !== undefined ? { sinceMs } : {});
		if (tokens) run.tokens = tokens;
	}
	return rebuildForkSummary(related);
}

function currentBranchEntries(ctx: ExtensionContext | undefined): unknown[] {
	try {
		return (ctx?.sessionManager.getBranch() as unknown[] | undefined) ?? [];
	} catch {
		return [];
	}
}

function modelInputCostPerMillion(model: unknown): number | undefined {
	const record = typeof model === "object" && model !== null ? model as Record<string, unknown> : undefined;
	const cost = typeof record?.cost === "object" && record.cost !== null ? record.cost as Record<string, unknown> : undefined;
	const input = cost?.input;
	return typeof input === "number" && Number.isFinite(input) && input > 0 ? input : undefined;
}

function modelDisplayName(model: unknown): string | undefined {
	const record = typeof model === "object" && model !== null ? model as Record<string, unknown> : undefined;
	const provider = typeof record?.provider === "string" ? record.provider : undefined;
	const id = typeof record?.id === "string" ? record.id : undefined;
	if (provider && id) return `${provider}/${id}`;
	return id ?? provider;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function readObservationalMemoryModelConfig(path: string): { provider: string; id: string } | undefined {
	try {
		const stat = statSync(path);
		const cached = modelConfigCache.get(path);
		if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;
		const root = recordValue(JSON.parse(readFileSync(path, "utf8")));
		const settings = recordValue(root?.["observational-memory"]);
		const model = recordValue(settings?.model) ?? recordValue(settings?.compactionModel);
		const provider = typeof model?.provider === "string" ? model.provider : undefined;
		const id = typeof model?.id === "string" ? model.id : undefined;
		const value = provider && id ? { provider, id } : undefined;
		modelConfigCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, value });
		return value;
	} catch {
		modelConfigCache.set(path, {});
		return undefined;
	}
}

function resolveObservationalMemoryModel(ctx: ExtensionContext | undefined): unknown {
	if (!ctx) return undefined;
	const globalModel = readObservationalMemoryModelConfig(join(getAgentDir(), "settings.json"));
	const projectModel = readObservationalMemoryModelConfig(join(ctx.cwd, ".pi", "settings.json"));
	const configured = projectModel ?? globalModel;
	if (configured) return ctx.modelRegistry.find(configured.provider, configured.id) ?? ctx.model;
	return ctx.model;
}

function estimateInputCost(tokens: TokenUsage, inputCostPerMillion: number | undefined): TokenUsage {
	if (!inputCostPerMillion || tokens.total <= 0) return tokens;
	return { ...tokens, cost: (inputCostPerMillion / 1_000_000) * tokens.total };
}

function withMemoryInputCost(memorySpend: ObservationalMemorySpendSummary, model: unknown): ObservationalMemorySpendSummary {
	const inputCostPerMillion = modelInputCostPerMillion(model);
	return {
		...memorySpend,
		visibleTokens: estimateInputCost(memorySpend.visibleTokens, inputCostPerMillion),
		fullTokens: estimateInputCost(memorySpend.fullTokens, inputCostPerMillion),
	};
}

function cachedMemorySpend(entries: unknown[]): ObservationalMemorySpendSummary {
	const lastEntry = entries.at(-1);
	if (memorySpendCache && memorySpendCache.length === entries.length && memorySpendCache.lastEntry === lastEntry) return memorySpendCache.value;
	const value = scanObservationalMemorySpend(entries);
	memorySpendCache = { length: entries.length, lastEntry, value };
	return value;
}

function tokenFilesUnder(root: string): string[] {
	const files: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) stack.push(fullPath);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
		}
	}
	return files;
}

function allDialogSpend(): TokenUsage | undefined {
	const tokens = emptyTokens();
	for (const file of tokenFilesUnder(join(getAgentDir(), "sessions"))) {
		const spend = parseSessionTokenFile(file);
		if (!spend) continue;
		tokens.input += spend.input;
		tokens.output += spend.output;
		tokens.total += spend.total;
		tokens.cost = (tokens.cost ?? 0) + (spend.cost ?? 0);
	}
	if (tokens.total <= 0) return undefined;
	if (!tokens.cost) delete tokens.cost;
	return tokens;
}

function allForkSummary(): ForkSummary {
	const scanned = scanForkRuns({ includeCompleted: true, includeTokens: false, source: FORK_SPEND_SOURCES });
	for (const run of scanned.runs) {
		const sinceMs = run.startedAt !== undefined ? Math.max(0, run.startedAt - 1_000) : undefined;
		const tokens = parseSessionTokens(run.sessionDir, sinceMs !== undefined ? { sinceMs } : {});
		if (tokens) run.tokens = tokens;
	}
	return rebuildForkSummary(scanned.runs);
}

function currentSpend(ctx?: ExtensionContext, scopeMode: "current" | "all" = "current"): SpendSnapshot {
	const scope = sessionScope(ctx);
	const rawMemorySpend = cachedMemorySpend(currentBranchEntries(ctx));
	const memoryModel = resolveObservationalMemoryModel(ctx);
	return {
		threadTokens: scopeMode === "all" ? allDialogSpend() : parseSessionTokenFile(scope.parentSessionFile),
		agentSpend: scopeMode === "all" ? scanAgentSpend() : scanAgentSpend(scope),
		forkSummary: scopeMode === "all" ? allForkSummary() : relatedForkSummary(scope),
		memorySpend: withMemoryInputCost(rawMemorySpend, memoryModel),
		memoryPricingModel: modelInputCostPerMillion(memoryModel) ? modelDisplayName(memoryModel) : undefined,
	};
}

function buildSpendStatus(spend: SpendSnapshot): string | undefined {
	const parts: string[] = [];
	const thread = formatSpend(spend.threadTokens);
	if (thread) parts.push(cyan(`◉ dialog ${thread}`));
	const agents = formatSpend(spend.agentSpend.totalTokens, spend.agentSpend.totalCost);
	if (agents) {
		const active = spend.agentSpend.active.length > 0 ? ` (${spend.agentSpend.active.length} active)` : "";
		parts.push(violet(`◆ agents ${agents}${active}`));
	}
	const forks = formatSpend(spend.forkSummary.totalTokens);
	if (forks) {
		const runCount = spend.forkSummary.runs.filter((run) => (run.tokens?.total ?? 0) > 0).length;
		const runLabel = runCount === 1 ? "fork" : "forks";
		parts.push(orange(`↯ ${runLabel} ${forks}`));
	}
	if (spend.memorySpend.visibleTokens.total > 0 || spend.memorySpend.fullTokens.total > 0) {
		const visible = formatSpend(spend.memorySpend.visibleTokens) ?? `${formatTokens(spend.memorySpend.visibleTokens.total)} tok`;
		const full = spend.memorySpend.fullTokens.total > spend.memorySpend.visibleTokens.total
			? ` · ${formatSpend(spend.memorySpend.fullTokens) ?? `${formatTokens(spend.memorySpend.fullTokens.total)} tok`} full`
			: "";
		parts.push(green(`✦ mem ${visible} ctx${full}`));
	}
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

function formatSpendLine(label: string, tokens: TokenUsage | undefined, extra?: string): string {
	const spend = formatSpend(tokens) ?? "0 tok";
	return `${label}: ${spend}${extra ? ` · ${extra}` : ""}`;
}

function formatMemorySpendLine(memory: ObservationalMemorySpendSummary, pricingModel?: string, scopeLabel?: string): string {
	const visible = formatSpend(memory.visibleTokens) ?? "0 tok";
	const full = formatSpend(memory.fullTokens) ?? "0 tok";
	const pricedAs = pricingModel ? ` · priced as ${pricingModel} input` : "";
	return `memory${scopeLabel ? ` (${scopeLabel})` : ""}: ${visible} visible context · ${full} full active (${memory.visibleObservations} obs/${memory.visibleReflections} refl visible · ${memory.fullObservations} obs/${memory.fullReflections} refl active${memory.droppedObservations ? ` · ${memory.droppedObservations} dropped` : ""}${pricedAs})`;
}

function formatSpendReport(ctx?: ExtensionContext, scopeMode: "current" | "all" = "current"): string {
	const spend = currentSpend(ctx, scopeMode);
	const lines = [scopeMode === "all" ? "Pi spend (all known)" : "Pi spend for this dialog"];
	lines.push(formatSpendLine("dialog", spend.threadTokens));
	lines.push(formatSpendLine("agents", spend.agentSpend.totalTokens, `${spend.agentSpend.runs.length} runs · ${spend.agentSpend.steps} steps${spend.agentSpend.active.length ? ` · ${spend.agentSpend.active.length} active` : ""}`));
	const forkScope = scopeMode === "all" ? "runs" : "related runs";
	lines.push(formatSpendLine("forks", spend.forkSummary.totalTokens, `${spend.forkSummary.runs.length} ${forkScope}${spend.forkSummary.running.length || spend.forkSummary.stale.length ? ` · ${spend.forkSummary.running.length} running · ${spend.forkSummary.stale.length} stale` : ""}`));
	lines.push(formatMemorySpendLine(spend.memorySpend, spend.memoryPricingModel, scopeMode === "all" ? "current branch" : undefined));
	return lines.join("\n");
}

function updateSpendStatus(ctx = latestCtx, options: { force?: boolean; now?: number } = {}): void {
	if (!ctx?.hasUI) return;
	const now = options.now ?? Date.now();
	const scope = sessionScope(ctx);
	const key = scopeKey(scope);
	if (options.force || key !== lastScopeKey || now - lastStatusAt >= REFRESH_MS) {
		lastStatus = buildSpendStatus(currentSpend(ctx));
		lastStatusAt = now;
		lastScopeKey = key;
	}
	ctx.ui.setStatus(STATUS_KEY, lastStatus);
	ctx.ui.requestRender?.();
}

function startRefresh(): void {
	if (refreshTimer) return;
	refreshTimer = setInterval(() => updateSpendStatus(), REFRESH_MS);
	refreshTimer.unref?.();
}

function stopRefresh(ctx = latestCtx): void {
	if (refreshTimer) clearInterval(refreshTimer);
	refreshTimer = undefined;
	lastStatus = undefined;
	lastStatusAt = 0;
	lastScopeKey = undefined;
	try {
		ctx?.ui.setStatus(STATUS_KEY, undefined);
	} catch {
		// UI context may already be stale during shutdown/reload.
	}
}

export const __test = {
	buildSpendStatus,
	formatSpendReport,
	readObservationalMemoryModelConfig,
};

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		updateSpendStatus(ctx, { force: true });
		startRefresh();
	});

	pi.on("turn_end", async (_event, ctx) => {
		latestCtx = ctx;
		updateSpendStatus(ctx, { force: true });
	});

	pi.on("agent_end", async (_event, ctx) => {
		latestCtx = ctx;
		updateSpendStatus(ctx, { force: true });
	});

	pi.on("model_select", async (_event, ctx) => {
		latestCtx = ctx;
		updateSpendStatus(ctx, { force: true });
	});

	pi.on("session_compact", async (_event, ctx) => {
		latestCtx = ctx;
		updateSpendStatus(ctx, { force: true });
	});

	pi.on("session_shutdown", async () => {
		stopRefresh();
		latestCtx = undefined;
	});

	const showSpend = async (args: string[], ctx: ExtensionContext) => {
		latestCtx = ctx;
		const scopeMode = args.some((arg) => arg === "all" || arg === "--all" || arg === "-a") ? "all" : "current";
		ctx.ui.notify(formatSpendReport(ctx, scopeMode), "info");
		updateSpendStatus(ctx, { force: true });
	};

	pi.registerCommand("pi-spend", {
		description: "Show token/cost split across dialog, agents, fork handlers, and observational memory. Use --all for all known spend.",
		handler: showSpend,
	});

	pi.registerCommand("spend", {
		description: "Alias for /pi-spend.",
		handler: showSpend,
	});

	pi.registerCommand("pi-spend-all", {
		description: "Show all known token/cost spend by category.",
		handler: async (_args, ctx) => showSpend(["--all"], ctx),
	});
}
