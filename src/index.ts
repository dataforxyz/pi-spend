import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readdir as readdirAsync } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, getSettingsListTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, type SettingItem, SettingsList, truncateToWidth } from "@earendil-works/pi-tui";
import {
	parseSessionTokenFile,
	parseSessionTokens,
	scanAgentSpend,
	scanForkRuns,
	scanObservationalMemorySpend,
	sumRunTokens,
	type AgentSpendRun,
	type AgentSpendSummary,
	type ForkRun,
	type ForkSource,
	type ForkSummary,
	type ObservationalMemorySpendSummary,
	type TokenUsage,
} from "./monitor.ts";
import { cyan, formatSpend, formatTokens, green, orange, violet } from "./formatting.ts";
import { isPiForksExtensionEnabledFromSettings } from "./pi-forks-detection.ts";

const STATUS_KEY = "pi-spend";
const ACTIVE_REFRESH_MS = 10_000;
const IDLE_REFRESH_MS = 60_000;
const ALL_REPORT_CACHE_MS = 60_000;
const FORK_SPEND_SOURCES: ForkSource[] = ["intercom", "return_on"];
const CONFIG_FILE = join(getAgentDir(), "pi-spend.json");

const FOOTER_METRICS = [
	{ id: "dialog", label: "Dialog usage", description: "Current dialog tokens and recorded cost." },
	{ id: "agents", label: "Agent runs", description: "Subagent tokens, cost, and active run count." },
	{ id: "forks", label: "Fork handlers", description: "Related intercom and return-on fork spend." },
	{ id: "memory", label: "Memory context", description: "Visible and full observational-memory footprint." },
	{ id: "lastMessage", label: "Last message time", description: "Local time of the latest user or assistant message." },
] as const;

type FooterMetric = (typeof FOOTER_METRICS)[number]["id"];
type FooterMetricConfig = Record<FooterMetric, boolean>;

const DEFAULT_FOOTER_METRICS: FooterMetricConfig = {
	dialog: true,
	agents: true,
	forks: true,
	memory: true,
	lastMessage: true,
};

let latestCtx: ExtensionContext | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
let footerMetrics: FooterMetricConfig = { ...DEFAULT_FOOTER_METRICS };
let savedFooterMetrics: FooterMetricConfig = { ...DEFAULT_FOOTER_METRICS };
let lastStatus: string | undefined;
let lastMessageAt: number | undefined;
let lastStatusAt = 0;
let lastScopeKey: string | undefined;
let lastSnapshotHasActiveWork = false;
let lastPublishedStatus: string | undefined;
let lastPublishedCtx: ExtensionContext | undefined;
let allReportCache: { createdAt: number; report: string; forkSpendEnabled: boolean } | undefined;

const modelConfigCache = new Map<string, { mtimeMs?: number; size?: number; value?: { provider: string; id: string } }>();
let memorySpendCache: { length: number; lastEntry?: unknown; value: ObservationalMemorySpendSummary } | undefined;

type SpendSnapshot = {
	threadTokens?: TokenUsage;
	agentSpend: AgentSpendSummary;
	forkSummary: ForkSummary;
	forkSpendEnabled: boolean;
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

function emptyAgentSpend(): AgentSpendSummary {
	return { runs: [], active: [], steps: 0, totalTokens: emptyTokens() };
}

function emptyMemorySpend(): ObservationalMemorySpendSummary {
	return {
		visibleTokens: emptyTokens(),
		fullTokens: emptyTokens(),
		visibleObservations: 0,
		visibleReflections: 0,
		fullObservations: 0,
		fullReflections: 0,
		droppedObservations: 0,
	};
}

function addTokenUsage(acc: TokenUsage, tokens: TokenUsage | undefined): void {
	if (!tokens) return;
	acc.input += tokens.input;
	acc.output += tokens.output;
	acc.total += tokens.total;
	acc.cost = (acc.cost ?? 0) + (tokens.cost ?? 0);
}

function emptyForkSummary(): ForkSummary {
	return {
		runs: [],
		running: [],
		stale: [],
		countsByStatus: { starting: 0, running: 0, complete: 0, failed: 0, stale: 0, unknown: 0 },
		totalTokens: emptyTokens(),
		maxRunningDurationMs: 0,
	};
}

function finalizeTokenUsage(tokens: TokenUsage): TokenUsage | undefined {
	if (tokens.total <= 0) return undefined;
	if (!tokens.cost) delete tokens.cost;
	return tokens;
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

function latestConversationMessageAt(entries: unknown[]): number | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = recordValue(entries[index]);
		if (entry?.type !== "message") continue;
		const message = recordValue(entry.message);
		if (message?.role !== "user" && message?.role !== "assistant") continue;
		const timestamp = message.timestamp;
		if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0) return timestamp;
	}
	return undefined;
}

function formatLastMessageTime(timestamp: number | undefined, now = Date.now()): string | undefined {
	if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) return undefined;
	const date = new Date(timestamp);
	const current = new Date(now);
	const pad = (value: number) => String(value).padStart(2, "0");
	const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	const sameDay =
		date.getFullYear() === current.getFullYear() &&
		date.getMonth() === current.getMonth() &&
		date.getDate() === current.getDate();
	if (sameDay) return time;
	const monthDay = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	return date.getFullYear() === current.getFullYear() ? `${monthDay} ${time}` : `${date.getFullYear()}-${monthDay} ${time}`;
}

function combinedFooterStatus(now = Date.now()): string | undefined {
	const parts: string[] = [];
	if (lastStatus) parts.push(lastStatus);
	if (footerMetrics.lastMessage) {
		const messageTime = formatLastMessageTime(lastMessageAt, now);
		if (messageTime) parts.push(`◷ last ${messageTime}`);
	}
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

function renderFooterStatus(ctx = latestCtx, now = Date.now(), force = false): void {
	if (!ctx?.hasUI) return;
	const status = combinedFooterStatus(now);
	if (!force && ctx === lastPublishedCtx && status === lastPublishedStatus) return;
	ctx.ui.setStatus(STATUS_KEY, status);
	lastPublishedCtx = ctx;
	lastPublishedStatus = status;
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

function normalizeFooterMetrics(value: unknown): FooterMetricConfig {
	const root = recordValue(value);
	const metrics = recordValue(root?.metrics);
	const normalized = { ...DEFAULT_FOOTER_METRICS };
	for (const metric of FOOTER_METRICS) {
		const configured = metrics?.[metric.id];
		if (typeof configured === "boolean") normalized[metric.id] = configured;
	}
	return normalized;
}

function loadFooterMetrics(): FooterMetricConfig {
	try {
		return normalizeFooterMetrics(JSON.parse(readFileSync(CONFIG_FILE, "utf8")));
	} catch {
		return { ...DEFAULT_FOOTER_METRICS };
	}
}

function saveFooterMetrics(metrics: FooterMetricConfig): void {
	mkdirSync(getAgentDir(), { recursive: true });
	writeFileSync(CONFIG_FILE, `${JSON.stringify({ metrics }, null, 2)}\n`, "utf8");
}

function hasPeriodicFooterMetrics(metrics = footerMetrics): boolean {
	return metrics.dialog || metrics.agents || metrics.forks || metrics.memory;
}

function footerMetricsEqual(a: FooterMetricConfig, b: FooterMetricConfig): boolean {
	return FOOTER_METRICS.every((metric) => a[metric.id] === b[metric.id]);
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

type ProgressUpdater = (message: string) => Promise<void>;

function nextTick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

async function setBusyStatus(ctx: ExtensionContext | undefined, message: string): Promise<void> {
	if (ctx?.hasUI) {
		ctx.ui.setStatus(STATUS_KEY, orange(`⧗ ${message}`));
	}
	await nextTick();
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
	for (const file of tokenFilesUnder(join(getAgentDir(), "sessions"))) addTokenUsage(tokens, parseSessionTokenFile(file));
	return finalizeTokenUsage(tokens);
}

async function tokenFilesUnderAsync(root: string, progress?: ProgressUpdater): Promise<string[]> {
	const files: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let entries;
		try {
			entries = await readdirAsync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) stack.push(fullPath);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
		}
		if (files.length > 0 && files.length % 250 === 0) await progress?.(`spend all: found ${files.length} session files`);
	}
	return files;
}

async function allDialogSpendAsync(progress?: ProgressUpdater): Promise<TokenUsage | undefined> {
	const files = await tokenFilesUnderAsync(join(getAgentDir(), "sessions"), progress);
	const tokens = emptyTokens();
	for (let index = 0; index < files.length; index++) {
		addTokenUsage(tokens, parseSessionTokenFile(files[index]));
		if (index % 25 === 0) await progress?.(`spend all: dialog ${index + 1}/${files.length}`);
	}
	return finalizeTokenUsage(tokens);
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

function agentSummaryFromRuns(runs: AgentSpendRun[]): AgentSpendSummary {
	const totalTokens = sumRunTokens(runs);
	return {
		runs,
		active: runs.filter((run) => run.active),
		steps: runs.reduce((sum, run) => sum + run.steps, 0),
		totalTokens,
		...(totalTokens.cost ? { totalCost: totalTokens.cost } : {}),
	};
}

async function allAgentSpendAsync(progress?: ProgressUpdater): Promise<AgentSpendSummary> {
	const scanned = scanForkRuns({ includeCompleted: true, includeTokens: false, source: "subagents" });
	const runs: AgentSpendRun[] = [];
	for (let index = 0; index < scanned.runs.length; index++) {
		const run = scanned.runs[index];
		const sinceMs = run.startedAt !== undefined ? Math.max(0, run.startedAt - 1_000) : undefined;
		const tokens = parseSessionTokens(run.sessionDir, sinceMs !== undefined ? { sinceMs } : {}) ?? emptyTokens();
		runs.push({
			id: run.id,
			state: run.status,
			steps: tokens.total > 0 ? 1 : 0,
			active: run.status === "running" || run.status === "starting",
			tokens,
			...(tokens.cost ? { cost: tokens.cost } : {}),
			...(run.cwd ? { cwd: run.cwd } : {}),
			...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
			...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
		});
		if (index % 25 === 0) await progress?.(`spend all: agents ${index + 1}/${scanned.runs.length}`);
	}
	return agentSummaryFromRuns(runs);
}

async function allForkSummaryAsync(progress?: ProgressUpdater): Promise<ForkSummary> {
	const scanned = scanForkRuns({ includeCompleted: true, includeTokens: false, source: FORK_SPEND_SOURCES });
	for (let index = 0; index < scanned.runs.length; index++) {
		const run = scanned.runs[index];
		const sinceMs = run.startedAt !== undefined ? Math.max(0, run.startedAt - 1_000) : undefined;
		const tokens = parseSessionTokens(run.sessionDir, sinceMs !== undefined ? { sinceMs } : {});
		if (tokens) run.tokens = tokens;
		if (index % 25 === 0) await progress?.(`spend all: forks ${index + 1}/${scanned.runs.length}`);
	}
	return rebuildForkSummary(scanned.runs);
}

function forkSpendEnabled(ctx?: ExtensionContext): boolean {
	return isPiForksExtensionEnabledFromSettings({ cwd: ctx?.cwd });
}

function currentSpend(
	ctx?: ExtensionContext,
	scopeMode: "current" | "all" = "current",
	metrics: FooterMetricConfig = DEFAULT_FOOTER_METRICS,
): SpendSnapshot {
	const scope = sessionScope(ctx);
	const forksEnabled = metrics.forks && forkSpendEnabled(ctx);
	const memoryModel = metrics.memory ? resolveObservationalMemoryModel(ctx) : undefined;
	const rawMemorySpend = metrics.memory ? cachedMemorySpend(currentBranchEntries(ctx)) : emptyMemorySpend();
	return {
		threadTokens: metrics.dialog ? (scopeMode === "all" ? allDialogSpend() : parseSessionTokenFile(scope.parentSessionFile)) : undefined,
		agentSpend: metrics.agents ? (scopeMode === "all" ? scanAgentSpend() : scanAgentSpend(scope)) : emptyAgentSpend(),
		forkSummary: forksEnabled ? (scopeMode === "all" ? allForkSummary() : relatedForkSummary(scope)) : emptyForkSummary(),
		forkSpendEnabled: forksEnabled,
		memorySpend: metrics.memory ? withMemoryInputCost(rawMemorySpend, memoryModel) : rawMemorySpend,
		memoryPricingModel: metrics.memory && modelInputCostPerMillion(memoryModel) ? modelDisplayName(memoryModel) : undefined,
	};
}

function spendHasActiveWork(spend: SpendSnapshot): boolean {
	return spend.agentSpend.active.length > 0 || spend.forkSummary.running.length > 0;
}

function refreshDelayMs(spendIsActive = lastSnapshotHasActiveWork): number {
	return spendIsActive ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS;
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
	const forks = spend.forkSpendEnabled ? formatSpend(spend.forkSummary.totalTokens) : undefined;
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

function formatSpendSnapshot(spend: SpendSnapshot, scopeMode: "current" | "all"): string {
	const lines = [scopeMode === "all" ? "Pi spend (all known)" : "Pi spend for this dialog"];
	lines.push(formatSpendLine("dialog", spend.threadTokens));
	lines.push(formatSpendLine("agents", spend.agentSpend.totalTokens, `${spend.agentSpend.runs.length} runs · ${spend.agentSpend.steps} steps${spend.agentSpend.active.length ? ` · ${spend.agentSpend.active.length} active` : ""}`));
	const forkScope = scopeMode === "all" ? "runs" : "related runs";
	lines.push(spend.forkSpendEnabled
		? formatSpendLine("forks", spend.forkSummary.totalTokens, `${spend.forkSummary.runs.length} ${forkScope}${spend.forkSummary.running.length || spend.forkSummary.stale.length ? ` · ${spend.forkSummary.running.length} running · ${spend.forkSummary.stale.length} stale` : ""}`)
		: "forks: disabled (pi-forks not enabled)");
	lines.push(formatMemorySpendLine(spend.memorySpend, spend.memoryPricingModel, scopeMode === "all" ? "current branch" : undefined));
	return lines.join("\n");
}

function formatSpendReport(ctx?: ExtensionContext, scopeMode: "current" | "all" = "current"): string {
	return formatSpendSnapshot(currentSpend(ctx, scopeMode), scopeMode);
}

async function formatAllSpendReport(ctx: ExtensionContext, progress?: ProgressUpdater): Promise<string> {
	const forksEnabled = forkSpendEnabled(ctx);
	const cached = allReportCache;
	if (cached && cached.forkSpendEnabled === forksEnabled && Date.now() - cached.createdAt < ALL_REPORT_CACHE_MS) return `${cached.report}\n(cache: reused ${Math.ceil((Date.now() - cached.createdAt) / 1000)}s-old all-spend scan)`;
	await progress?.("spend all: scanning dialog sessions");
	const threadTokens = await allDialogSpendAsync(progress);
	await progress?.("spend all: scanning subagents");
	const agentSpend = await allAgentSpendAsync(progress);
	let forkSummary = emptyForkSummary();
	if (forksEnabled) {
		await progress?.("spend all: scanning fork handlers");
		forkSummary = await allForkSummaryAsync(progress);
	}
	const memoryModel = resolveObservationalMemoryModel(ctx);
	const spend: SpendSnapshot = {
		threadTokens,
		agentSpend,
		forkSummary,
		forkSpendEnabled: forksEnabled,
		memorySpend: withMemoryInputCost(cachedMemorySpend(currentBranchEntries(ctx)), memoryModel),
		memoryPricingModel: modelInputCostPerMillion(memoryModel) ? modelDisplayName(memoryModel) : undefined,
	};
	const report = formatSpendSnapshot(spend, "all");
	allReportCache = { createdAt: Date.now(), report, forkSpendEnabled: forksEnabled };
	return report;
}

function updateSpendStatus(ctx = latestCtx, options: { force?: boolean; forcePublish?: boolean; now?: number } = {}): void {
	if (!ctx?.hasUI) return;
	const now = options.now ?? Date.now();
	if (!hasPeriodicFooterMetrics()) {
		lastStatus = undefined;
		lastStatusAt = now;
		lastScopeKey = undefined;
		lastSnapshotHasActiveWork = false;
		renderFooterStatus(ctx, now, options.forcePublish);
		return;
	}
	const scope = sessionScope(ctx);
	const key = scopeKey(scope);
	if (options.force || key !== lastScopeKey || now - lastStatusAt >= refreshDelayMs()) {
		const spend = currentSpend(ctx, "current", footerMetrics);
		lastStatus = buildSpendStatus(spend);
		lastSnapshotHasActiveWork = spendHasActiveWork(spend);
		lastStatusAt = now;
		lastScopeKey = key;
	}
	renderFooterStatus(ctx, now, options.forcePublish);
}

function startRefresh(): void {
	if (refreshTimer || !hasPeriodicFooterMetrics()) return;
	refreshTimer = setTimeout(() => {
		refreshTimer = undefined;
		updateSpendStatus();
		startRefresh();
	}, refreshDelayMs());
	refreshTimer.unref?.();
}

function stopRefreshTimer(): void {
	if (refreshTimer) clearTimeout(refreshTimer);
	refreshTimer = undefined;
}

function syncRefreshTimer(): void {
	stopRefreshTimer();
	if (hasPeriodicFooterMetrics()) startRefresh();
}

function stopRefresh(ctx = latestCtx): void {
	stopRefreshTimer();
	lastStatus = undefined;
	lastMessageAt = undefined;
	lastStatusAt = 0;
	lastScopeKey = undefined;
	lastSnapshotHasActiveWork = false;
	lastPublishedStatus = undefined;
	lastPublishedCtx = undefined;
	try {
		ctx?.ui.setStatus(STATUS_KEY, undefined);
	} catch {
		// UI context may already be stale during shutdown/reload.
	}
}

export const __test = {
	buildSpendStatus,
	combinedFooterStatus,
	footerMetricsEqual,
	formatLastMessageTime,
	formatSpendReport,
	isPiForksExtensionEnabledFromSettings,
	latestConversationMessageAt,
	normalizeFooterMetrics,
	readObservationalMemoryModelConfig,
	refreshDelayMs,
	renderFooterStatus,
	spendHasActiveWork,
};

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		savedFooterMetrics = loadFooterMetrics();
		footerMetrics = { ...savedFooterMetrics };
		lastMessageAt = latestConversationMessageAt(currentBranchEntries(ctx));
		updateSpendStatus(ctx, { force: true, forcePublish: true });
		syncRefreshTimer();
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "user" && event.message.role !== "assistant") return;
		latestCtx = ctx;
		lastMessageAt = event.message.timestamp;
		renderFooterStatus(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		latestCtx = ctx;
		updateSpendStatus(ctx, { force: true });
		syncRefreshTimer();
	});

	pi.on("agent_end", async (_event, ctx) => {
		latestCtx = ctx;
		updateSpendStatus(ctx, { force: true });
		syncRefreshTimer();
	});

	pi.on("model_select", async (_event, ctx) => {
		latestCtx = ctx;
		updateSpendStatus(ctx, { force: true });
		syncRefreshTimer();
	});

	pi.on("session_compact", async (_event, ctx) => {
		latestCtx = ctx;
		updateSpendStatus(ctx, { force: true });
		syncRefreshTimer();
	});

	pi.on("session_shutdown", async () => {
		stopRefresh();
		latestCtx = undefined;
	});

	const showSpend = async (args: unknown, ctx: ExtensionContext) => {
		latestCtx = ctx;
		const argv = Array.isArray(args)
			? args.map(String)
			: typeof args === "string"
				? args.trim().split(/\s+/).filter(Boolean)
				: [];
		const scopeMode = argv.some((arg) => arg === "all" || arg === "--all" || arg === "-a") ? "all" : "current";
		if (scopeMode === "all") {
			await setBusyStatus(ctx, "spend all: starting scan");
			const report = await formatAllSpendReport(ctx, (message) => setBusyStatus(ctx, message));
			ctx.ui.notify(report, "info");
			updateSpendStatus(ctx, { force: true });
			syncRefreshTimer();
			return;
		}
		ctx.ui.notify(formatSpendReport(ctx), "info");
		updateSpendStatus(ctx, { force: true });
		syncRefreshTimer();
	};

	pi.registerCommand("pi-cost-config", {
		description: "Configure which pi-spend metrics appear in the footer.",
		handler: async (_args, ctx) => {
			const mode = (ctx as ExtensionContext & { mode?: string }).mode;
			if (!ctx.hasUI || (mode !== undefined && mode !== "tui")) {
				ctx.ui.notify("/pi-cost-config requires TUI mode", "error");
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const items: SettingItem[] = FOOTER_METRICS.map((metric) => ({
					id: metric.id,
					label: metric.label,
					description: metric.description,
					currentValue: footerMetrics[metric.id] ? "on" : "off",
					values: ["on", "off"],
				}));

				const container = new Container();
				container.addChild({
					render: (width: number) => {
						const dirty = !footerMetricsEqual(footerMetrics, savedFooterMetrics);
						const title = `Pi Cost Footer Metrics${dirty ? " *" : ""}`;
						return [truncateToWidth(theme.fg("accent", theme.bold(title)), width), ""];
					},
					invalidate() {},
				});

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 12),
					getSettingsListTheme(),
					(id, newValue) => {
						const metric = FOOTER_METRICS.find((candidate) => candidate.id === id);
						if (!metric) return;
						footerMetrics = { ...footerMetrics, [metric.id]: newValue === "on" };
						lastStatusAt = 0;
						lastScopeKey = undefined;
						updateSpendStatus(ctx, { force: true });
						syncRefreshTimer();
					},
					() => done(undefined),
				);
				container.addChild(settingsList);
				container.addChild({
					render: (width: number) => {
						const dirty = !footerMetricsEqual(footerMetrics, savedFooterMetrics);
						const help = dirty
							? "Current Pi changed · Ctrl+S save as default · Esc close"
							: "Changes affect current Pi · Ctrl+S save as default · Esc close";
						return ["", truncateToWidth(theme.fg("dim", help), width)];
					},
					invalidate() {},
				});

				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (input: string) => {
						if (matchesKey(input, "ctrl+s")) {
							try {
								saveFooterMetrics(footerMetrics);
								savedFooterMetrics = { ...footerMetrics };
								ctx.ui.notify("Pi cost footer saved as the global default", "info");
							} catch (error) {
								ctx.ui.notify(`Could not save pi-spend config: ${error instanceof Error ? error.message : String(error)}`, "error");
							}
							tui.requestRender();
							return;
						}
						settingsList.handleInput(input);
						tui.requestRender();
					},
				};
			});
		},
	});

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
