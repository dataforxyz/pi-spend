import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	parseSessionTokenFile,
	scanAgentSpend,
	scanForkRuns,
	scanObservationalMemorySpend,
	sumRunTokens,
	type AgentSpendSummary,
	type ForkRun,
	type ForkSummary,
	type ObservationalMemorySpendSummary,
	type TokenUsage,
} from "./monitor.ts";
import { cyan, formatSpend, formatTokens, green, orange, violet } from "./formatting.ts";

const STATUS_KEY = "pi-spend";
const REFRESH_MS = 10_000;

let latestCtx: ExtensionContext | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
let lastStatus: string | undefined;
let lastStatusAt = 0;
let lastScopeKey: string | undefined;

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
	if (scope.parentSessionId && run.parentSessionId === scope.parentSessionId) return true;
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
	const scanned = scanForkRuns({ includeCompleted: true, includeTokens: true });
	return rebuildForkSummary(scanned.runs.filter((run) => runMatchesCurrentSession(run, scope)));
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
	if (!existsSync(path)) return undefined;
	try {
		const root = recordValue(JSON.parse(readFileSync(path, "utf8")));
		const settings = recordValue(root?.["observational-memory"]);
		const model = recordValue(settings?.model) ?? recordValue(settings?.compactionModel);
		const provider = typeof model?.provider === "string" ? model.provider : undefined;
		const id = typeof model?.id === "string" ? model.id : undefined;
		return provider && id ? { provider, id } : undefined;
	} catch {
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

function currentSpend(ctx?: ExtensionContext): SpendSnapshot {
	const scope = sessionScope(ctx);
	const rawMemorySpend = scanObservationalMemorySpend(currentBranchEntries(ctx));
	const memoryModel = resolveObservationalMemoryModel(ctx);
	return {
		threadTokens: parseSessionTokenFile(scope.parentSessionFile),
		agentSpend: scanAgentSpend({ parentSessionFile: scope.parentSessionFile }),
		forkSummary: relatedForkSummary(scope),
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

function formatMemorySpendLine(memory: ObservationalMemorySpendSummary, pricingModel?: string): string {
	const visible = formatSpend(memory.visibleTokens) ?? "0 tok";
	const full = formatSpend(memory.fullTokens) ?? "0 tok";
	const pricedAs = pricingModel ? ` · priced as ${pricingModel} input` : "";
	return `memory: ${visible} visible context · ${full} full active (${memory.visibleObservations} obs/${memory.visibleReflections} refl visible · ${memory.fullObservations} obs/${memory.fullReflections} refl active${memory.droppedObservations ? ` · ${memory.droppedObservations} dropped` : ""}${pricedAs})`;
}

function formatSpendReport(ctx?: ExtensionContext): string {
	const spend = currentSpend(ctx);
	const lines = ["Pi spend for this dialog"];
	lines.push(formatSpendLine("dialog", spend.threadTokens));
	lines.push(formatSpendLine("agents", spend.agentSpend.totalTokens, `${spend.agentSpend.runs.length} runs · ${spend.agentSpend.steps} steps${spend.agentSpend.active.length ? ` · ${spend.agentSpend.active.length} active` : ""}`));
	lines.push(formatSpendLine("forks", spend.forkSummary.totalTokens, `${spend.forkSummary.runs.length} related runs${spend.forkSummary.running.length || spend.forkSummary.stale.length ? ` · ${spend.forkSummary.running.length} running · ${spend.forkSummary.stale.length} stale` : ""}`));
	lines.push(formatMemorySpendLine(spend.memorySpend, spend.memoryPricingModel));
	return lines.join("\n");
}

function updateSpendStatus(ctx = latestCtx, now = Date.now()): void {
	if (!ctx?.hasUI) return;
	const scope = sessionScope(ctx);
	const key = scopeKey(scope);
	if (key !== lastScopeKey || now - lastStatusAt >= REFRESH_MS) {
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
		updateSpendStatus(ctx, 0);
		startRefresh();
	});

	pi.on("turn_end", async (_event, ctx) => {
		latestCtx = ctx;
		updateSpendStatus(ctx, 0);
	});

	pi.on("agent_end", async (_event, ctx) => {
		latestCtx = ctx;
		updateSpendStatus(ctx, 0);
	});

	pi.on("model_select", async (_event, ctx) => {
		latestCtx = ctx;
		updateSpendStatus(ctx, 0);
	});

	pi.on("session_compact", async (_event, ctx) => {
		latestCtx = ctx;
		updateSpendStatus(ctx, 0);
	});

	pi.on("session_shutdown", async () => {
		stopRefresh();
		latestCtx = undefined;
	});

	pi.registerCommand("pi-spend", {
		description: "Show this dialog's token/cost split across dialog, agents, fork handlers, and observational memory.",
		handler: async (_args, ctx) => {
			latestCtx = ctx;
			ctx.ui.notify(formatSpendReport(ctx), "info");
			updateSpendStatus(ctx, 0);
		},
	});

	pi.registerCommand("spend", {
		description: "Alias for /pi-spend.",
		handler: async (_args, ctx) => {
			latestCtx = ctx;
			ctx.ui.notify(formatSpendReport(ctx), "info");
			updateSpendStatus(ctx, 0);
		},
	});
}
