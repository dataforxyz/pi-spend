import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseSessionTokenFile } from "../src/monitor.ts";

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("unchanged session-token cache hits do not rewrite the shared persistent cache", async () => {
	const originalHome = process.env.HOME;
	const originalCacheFile = process.env.PI_SPEND_TOKEN_CACHE_FILE;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-spend-cache-home-"));
	const sessionFile = path.join(home, ".pi", "agent", "sessions", "session.jsonl");
	const cacheFile = path.join(home, "state", "session-token-cache.json");
	fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	fs.writeFileSync(sessionFile, `${JSON.stringify({ usage: { input: 100, output: 25 } })}\n`, "utf8");
	process.env.HOME = home;
	process.env.PI_SPEND_TOKEN_CACHE_FILE = cacheFile;

	try {
		assert.deepEqual(parseSessionTokenFile(sessionFile), { input: 100, output: 25, total: 125 });
		await wait(1_100);
		const firstWrite = fs.statSync(cacheFile).mtimeMs;

		assert.deepEqual(parseSessionTokenFile(sessionFile), { input: 100, output: 25, total: 125 });
		await wait(1_100);
		assert.equal(fs.statSync(cacheFile).mtimeMs, firstWrite);
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalCacheFile === undefined) delete process.env.PI_SPEND_TOKEN_CACHE_FILE;
		else process.env.PI_SPEND_TOKEN_CACHE_FILE = originalCacheFile;
		fs.rmSync(home, { recursive: true, force: true });
	}
});
