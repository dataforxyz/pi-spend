import test from "node:test";
import assert from "node:assert/strict";
import { scanObservationalMemorySpend } from "../src/monitor.ts";

test("scanObservationalMemorySpend reports visible and full memory token footprint", () => {
	const entries = [
		{ type: "custom", customType: "om.observations.recorded", data: { observations: [{ id: "obs-a", tokenCount: 100 }, { id: "obs-b", tokenCount: 250 }] } },
		{ type: "custom", customType: "om.reflections.recorded", data: { reflections: [{ id: "ref-a", tokenCount: 75 }] } },
		{ type: "compaction", details: { type: "om.folded", version: 1, observations: [{ id: "obs-a", tokenCount: 100 }], reflections: [] } },
		{ type: "custom", customType: "om.observations.dropped", data: { observationIds: ["obs-a"] } },
	];

	const spend = scanObservationalMemorySpend(entries);

	assert.equal(spend.visibleTokens.total, 100);
	assert.equal(spend.fullTokens.total, 325);
	assert.equal(spend.visibleObservations, 1);
	assert.equal(spend.visibleReflections, 0);
	assert.equal(spend.fullObservations, 1);
	assert.equal(spend.fullReflections, 1);
	assert.equal(spend.droppedObservations, 1);
});
