import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scanAgentSpend } from "../src/monitor.ts";

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function writeJsonl(file: string, entries: unknown[]): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

test("scanAgentSpend includes pi-subagents fork-handler session spend", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-spend-home-"));
	const parentSessionFile = path.join(home, "parent.jsonl");
	const sessionDir = path.join(home, ".local/state/pi-subagents/handlers/sbf_1/sessions");
	writeJsonl(path.join(sessionDir, "child.jsonl"), [
		{ timestamp: 4_000, usage: { input: 100, output: 25, cost: 0.125 } },
		{ timestamp: 5_000, message: { usage: { inputTokens: 10, outputTokens: 5, cost: { total: 0.015 } } } },
	]);
	writeJson(path.join(home, ".local/state/pi-subagents/handlers.json"), {
		version: 1,
		handlers: [
			{ id: "sbf_1", status: "complete", parentSessionFile, parentIntercomTarget: "session-id", sessionDir, startedAt: 3_500 },
			{ id: "sbf_other", status: "complete", parentSessionFile: "other.jsonl", sessionDir },
		],
	});

	const spend = scanAgentSpend({ homeDir: home, rootDir: path.join(home, "missing-legacy"), parentSessionFile });

	assert.equal(spend.runs.length, 1);
	assert.equal(spend.steps, 1);
	assert.equal(spend.totalTokens.total, 140);
	assert.ok(Math.abs((spend.totalCost ?? 0) - 0.14) < 0.000001);

	const spendBySessionId = scanAgentSpend({ homeDir: home, rootDir: path.join(home, "missing-legacy"), parentSessionId: "session-id" });
	assert.equal(spendBySessionId.runs.length, 1);
	assert.equal(spendBySessionId.totalTokens.total, 140);
});
