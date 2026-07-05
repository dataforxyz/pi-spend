import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripAnsi } from "../src/formatting.ts";
import { __test } from "../src/index.ts";

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function emptyAgentSpend() {
	return { runs: [], active: [], steps: 0, totalTokens: { input: 0, output: 0, total: 0 } };
}

function emptyMemorySpend() {
	return {
		visibleTokens: { input: 0, output: 0, total: 0 },
		fullTokens: { input: 0, output: 0, total: 0 },
		visibleObservations: 0,
		visibleReflections: 0,
		fullObservations: 0,
		fullReflections: 0,
		droppedObservations: 0,
	};
}

test("pi-forks detection is false when a checkout exists but the package is not enabled", () => {
	const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-spend-forks-home-"));
	const agentDir = path.join(homeDir, ".pi", "agent");
	fs.mkdirSync(path.join(agentDir, "git", "github.com", "dataforxyz", "pi-forks"), { recursive: true });
	writeJson(path.join(agentDir, "settings.json"), { packages: ["git:github.com/dataforxyz/pi-spend"] });

	assert.equal(__test.isPiForksExtensionEnabledFromSettings({ homeDir, cwd: homeDir, env: {} }), false);
});

test("pi-forks detection follows package settings, filters, and project overrides", () => {
	const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-spend-forks-home-"));
	const agentDir = path.join(homeDir, ".pi", "agent");
	const repoDir = path.join(homeDir, "repo");
	writeJson(path.join(agentDir, "settings.json"), { packages: ["git:github.com/dataforxyz/pi-forks"] });

	assert.equal(__test.isPiForksExtensionEnabledFromSettings({ homeDir, cwd: repoDir, env: {} }), true);

	writeJson(path.join(agentDir, "settings.json"), { packages: [{ source: "git:github.com/dataforxyz/pi-forks", extensions: [] }] });
	assert.equal(__test.isPiForksExtensionEnabledFromSettings({ homeDir, cwd: repoDir, env: {} }), false);

	writeJson(path.join(agentDir, "settings.json"), { packages: [{ source: "git:github.com/dataforxyz/pi-forks", extensions: ["src/index.ts"] }] });
	assert.equal(__test.isPiForksExtensionEnabledFromSettings({ homeDir, cwd: repoDir, env: {} }), true);

	writeJson(path.join(repoDir, ".pi", "settings.json"), { packages: ["git:github.com/dataforxyz/pi-spend"] });
	assert.equal(__test.isPiForksExtensionEnabledFromSettings({ homeDir, cwd: repoDir, env: {} }), false);
});

test("spend status does not show fork spend when fork spend is disabled", () => {
	const status = __test.buildSpendStatus({
		threadTokens: undefined,
		agentSpend: emptyAgentSpend(),
		forkSpendEnabled: false,
		forkSummary: {
			runs: [{ id: "roh_old", source: "return_on", label: "old", status: "complete", tokens: { input: 100, output: 25, total: 125 } }],
			running: [],
			stale: [],
			countsByStatus: { starting: 0, running: 0, complete: 1, failed: 0, stale: 0, unknown: 0 },
			totalTokens: { input: 100, output: 25, total: 125 },
			maxRunningDurationMs: 0,
		},
		memorySpend: emptyMemorySpend(),
	});

	assert.equal(stripAnsi(status ?? ""), "");
});
