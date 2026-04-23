import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { RateLimitedQueue, detectTier, effectiveRpm, type TierConfig } from "../extensions/research-tools/rate-limit-queue.js";

describe("detectTier", () => {
	it("defaults to Tier 1 when ANTHROPIC_TIER is unset", () => {
		const prev = process.env.ANTHROPIC_TIER;
		delete process.env.ANTHROPIC_TIER;
		try {
			const t = detectTier();
			assert.equal(t.name, "Tier 1");
			assert.equal(t.rpm, 50);
			assert.equal(t.maxConcurrent, 4);
		} finally {
			if (prev === undefined) delete process.env.ANTHROPIC_TIER; else process.env.ANTHROPIC_TIER = prev;
		}
	});
	it("reads numeric ANTHROPIC_TIER (1..4)", () => {
		for (const [n, expected] of [["1", "Tier 1"], ["2", "Tier 2"], ["3", "Tier 3"], ["4", "Tier 4"]] as const) {
			const t = detectTier({ ANTHROPIC_TIER: n } as any);
			assert.equal(t.name, expected);
		}
	});
	it("falls back to Tier 1 on garbage", () => {
		const t = detectTier({ ANTHROPIC_TIER: "banana" } as any);
		assert.equal(t.name, "Tier 1");
	});
	it("effective RPM is 80% of tier RPM", () => {
		assert.equal(effectiveRpm({ name: "x", rpm: 100, maxConcurrent: 1 } as TierConfig), 80);
	});
});

describe("RateLimitedQueue — behavior", () => {
	it("runs a single task and resolves its value", async () => {
		const q = new RateLimitedQueue({ tier: { name: "t", rpm: 1000, maxConcurrent: 4 } });
		const result = await q.submit(async () => 42);
		assert.equal(result, 42);
		assert.equal(q.stats().completed, 1);
	});

	it("propagates rejection", async () => {
		const q = new RateLimitedQueue({ tier: { name: "t", rpm: 1000, maxConcurrent: 4 } });
		await assert.rejects(() => q.submit(async () => { throw new Error("boom"); }), /boom/);
		assert.equal(q.stats().failed, 1);
	});

	it("respects maxConcurrent under a burst", async () => {
		const tier: TierConfig = { name: "t", rpm: 10_000, maxConcurrent: 3 };
		const q = new RateLimitedQueue({ tier });
		let active = 0;
		let peak = 0;
		const tasks = Array.from({ length: 20 }, () => async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 15));
			active--;
			return "ok";
		});
		const results = await q.submitAll(tasks);
		assert.equal(results.length, 20);
		assert.ok(peak <= 3, `peak concurrency ${peak} should be <= 3`);
	});

	it("preserves submission order in result array", async () => {
		const q = new RateLimitedQueue({ tier: { name: "t", rpm: 10_000, maxConcurrent: 4 } });
		const tasks = Array.from({ length: 10 }, (_, i) => async () => {
			await new Promise((r) => setTimeout(r, Math.random() * 10));
			return i;
		});
		const results = await q.submitAll(tasks);
		assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	it("throttles under a tight RPM budget (only 2 tokens/minute)", async () => {
		// Tight budget: 2 per minute. Concurrency = 4, so throttling is the RPM
		// limit, not concurrency. With 3 tasks we expect the first 2 to fire
		// immediately and the 3rd to wait for a token refill (~30s at 2 RPM).
		// We stub the clock and setTimeout so the test runs synchronously.
		let now = 0;
		const timers: Array<{ fn: () => void; when: number }> = [];
		const fakeSetTimeout = (fn: () => void, ms: number): unknown => {
			timers.push({ fn, when: now + ms });
			return timers.length - 1;
		};
		const advance = (ms: number) => {
			now += ms;
			while (true) {
				const ready = timers.find((t) => t.when <= now);
				if (!ready) break;
				timers.splice(timers.indexOf(ready), 1);
				ready.fn();
			}
		};

		const q = new RateLimitedQueue({
			tier: { name: "tight", rpm: 3, maxConcurrent: 4 }, // effective = floor(3*0.8)=2 tokens
			now: () => now,
			setTimeout: fakeSetTimeout as any,
		});

		const order: number[] = [];
		const p1 = q.submit(async () => { order.push(1); return 1; });
		const p2 = q.submit(async () => { order.push(2); return 2; });
		const p3 = q.submit(async () => { order.push(3); return 3; });

		// Give enough microtask ticks for both initial tokens to drain. Since each
		// submit() calls drain() synchronously in the constructor path, and tasks
		// resolve on microtasks, a handful of ticks is plenty.
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		assert.deepEqual(order.slice().sort(), [1, 2], `first 2 tasks should have run with initial 2 tokens, got ${JSON.stringify(order)}`);

		// Advance 30s: at 2 RPM, that's 1 token (30s * 2/60 = 1). Third should fire.
		advance(30_000);
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		assert.deepEqual(order.slice().sort(), [1, 2, 3], `after refill: ${JSON.stringify(order)}`);

		await Promise.all([p1, p2, p3]);
	});
});
