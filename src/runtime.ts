import * as os from "node:os";
import * as path from "node:path";

export type ForkSource = "intercom" | "return_on" | "subagents";
export type ForkHandlerKind = "intercom" | "return-on" | "subagent";
export type ForkStatus = "starting" | "running" | "complete" | "failed" | "unknown" | "stale";

const SOURCE_STATE_DIR: Record<ForkSource, string> = {
	intercom: "pi-intercom",
	return_on: "pi-return-on",
	subagents: "pi-subagents",
};

export function shortForkRunId(runId: string | undefined): string {
	const cleaned = runId?.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ?? "";
	const withoutPrefix = cleaned.replace(/^(?:icfh|roh|sbf)-?/i, "");
	const parts = withoutPrefix.split("-").filter(Boolean);
	const compact = parts.length >= 2 ? parts.slice(0, 2).join("-") : withoutPrefix;
	return (compact || "handler").slice(0, 24);
}

export function forkHandlerKind(source: ForkSource): ForkHandlerKind {
	if (source === "return_on") return "return-on";
	if (source === "subagents") return "subagent";
	return "intercom";
}

export function buildForkIntercomIdentity(source: ForkSource, runId?: string): { kind: ForkHandlerKind; runId?: string; statusTag: string; sessionName: string } {
	const kind = forkHandlerKind(source);
	const statusTag = runId ? `fork-handler:${kind}:${runId}` : `fork-handler:${kind}`;
	return {
		kind,
		...(runId ? { runId } : {}),
		statusTag,
		sessionName: `fork-${kind}-${shortForkRunId(runId)}`,
	};
}

export function getForkStateDir(source: ForkSource, homeDir = os.homedir()): string {
	return path.join(homeDir, ".local", "state", SOURCE_STATE_DIR[source]);
}

export function getForkHandlersDir(source: ForkSource, homeDir = os.homedir()): string {
	return path.join(getForkStateDir(source, homeDir), "handlers");
}

export function getForkHandlersFile(source: ForkSource, homeDir = os.homedir()): string {
	return path.join(getForkStateDir(source, homeDir), "handlers.json");
}

export function isProcessAlive(pid: number | undefined): boolean | undefined {
	if (!pid || !Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
