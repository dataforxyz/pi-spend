import test from "node:test";
import assert from "node:assert/strict";
import { formatCost, formatSpend, formatTokens, stripAnsi } from "../src/formatting.ts";
import { __test } from "../src/index.ts";

test("formatSpend shows token and cost compactly", () => {
	assert.equal(formatTokens(33_000), "33k");
	assert.equal(formatCost(0.165), "$0.165");
	assert.equal(formatSpend({ input: 33_000, output: 0, total: 33_000, cost: 0.165 }), "33k/$0.165");
});

test("spend status labels memory context and full footprint", () => {
	const status = __test.buildSpendStatus({
		threadTokens: { input: 1_000, output: 200, total: 1_200, cost: 0.01 },
		agentSpend: { runs: [], active: [], steps: 0, totalTokens: { input: 0, output: 0, total: 0 } },
		forkSummary: { runs: [], running: [], stale: [], countsByStatus: { starting: 0, running: 0, complete: 0, failed: 0, stale: 0, unknown: 0 }, totalTokens: { input: 0, output: 0, total: 0 }, maxRunningDurationMs: 0 },
		memorySpend: {
			visibleTokens: { input: 33_000, output: 0, total: 33_000, cost: 0.165 },
			fullTokens: { input: 35_000, output: 0, total: 35_000, cost: 0.175 },
			visibleObservations: 1,
			visibleReflections: 0,
			fullObservations: 2,
			fullReflections: 0,
			droppedObservations: 0,
		},
	});
	assert.equal(stripAnsi(status ?? ""), "◉ dialog 1.2k/$0.010 · ✦ mem 33k/$0.165 ctx · 35k/$0.175 full");
});
