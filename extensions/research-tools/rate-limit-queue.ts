/**
 * rate-limit-queue.ts — Tier-aware scheduler for parallel Opus calls.
 *
 * Problem: running 100+ persona calls in parallel against Anthropic's Opus
 * tier limits produces 429s in seconds. We need to throttle to ~80% of the
 * detected tier's per-minute allowance, with bounded concurrency.
 *
 * Design:
 *   - Token bucket: emits `rpmBudget` tokens per minute, refills continuously.
 *   - Concurrency cap: never more than `maxConcurrent` active requests at once
 *     (protects against bursts even when the bucket allows).
 *   - Queue: FIFO; submit() returns a promise that resolves when the task runs.
 *   - Tier detection: reads ANTHROPIC_TIER env var (default 1 = safe).
 *
 * Anthropic rough numbers (subject to change; treat as conservative defaults):
 *   Tier 1: ~50 RPM Opus → 40 effective → concurrency ~4
 *   Tier 2: ~1000 RPM    → 800 effective → concurrency ~8 (cap)
 *   Tier 3: ~2000        → 1600         → concurrency ~8 (cap)
 *   Tier 4: ~4000        → 3200         → concurrency ~8 (cap)
 *
 * Concurrency is capped at 8 regardless of tier: empirically, beyond ~8
 * parallel calls tool-use round-trips start stepping on each other and
 * downstream SDK backoff compounds. 8 is a safe ceiling.
 */

// ── Tier config ───────────────────────────────────────────────

export interface TierConfig {
	name: string;
	rpm: number;           // requests per minute for Opus
	maxConcurrent: number; // enforced concurrency cap
}

const TIERS: Record<number, TierConfig> = {
	1: { name: "Tier 1", rpm: 50,   maxConcurrent: 4 },
	2: { name: "Tier 2", rpm: 1000, maxConcurrent: 8 },
	3: { name: "Tier 3", rpm: 2000, maxConcurrent: 8 },
	4: { name: "Tier 4", rpm: 4000, maxConcurrent: 8 },
};

export function detectTier(env: NodeJS.ProcessEnv = process.env): TierConfig {
	const raw = env.ANTHROPIC_TIER;
	const n = raw ? parseInt(raw, 10) : NaN;
	if (Number.isFinite(n) && TIERS[n]) return TIERS[n]!;
	return TIERS[1]!; // safe default
}

// 80% of tier RPM becomes our effective budget.
export function effectiveRpm(tier: TierConfig): number {
	return Math.floor(tier.rpm * 0.8);
}

// ── Token bucket ──────────────────────────────────────────────

interface BucketState {
	tokens: number;
	capacity: number;
	refillPerMs: number;
	lastRefillMs: number;
}

function makeBucket(rpm: number, nowMs: number): BucketState {
	// Capacity = 1 minute worth of tokens. Refill at rpm/60000 tokens per ms.
	return {
		tokens: rpm,
		capacity: rpm,
		refillPerMs: rpm / 60_000,
		lastRefillMs: nowMs,
	};
}

function refill(bucket: BucketState, nowMs: number): void {
	const elapsed = Math.max(0, nowMs - bucket.lastRefillMs);
	bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerMs);
	bucket.lastRefillMs = nowMs;
}

// ── Queue ─────────────────────────────────────────────────────

export interface QueueOptions {
	tier?: TierConfig;
	// Injectable clock for tests.
	now?: () => number;
	// Injectable timer for tests. Should behave like setTimeout.
	setTimeout?: (fn: () => void, ms: number) => unknown;
	clearTimeout?: (id: unknown) => void;
}

export interface QueueStats {
	tier: string;
	rpmBudget: number;
	maxConcurrent: number;
	inFlight: number;
	queued: number;
	completed: number;
	failed: number;
}

type Task<T> = {
	run: () => Promise<T>;
	resolve: (v: T) => void;
	reject: (e: unknown) => void;
};

export class RateLimitedQueue {
	private readonly tier: TierConfig;
	private readonly rpmBudget: number;
	private readonly bucket: BucketState;
	private readonly now: () => number;
	private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
	private readonly pending: Task<any>[] = [];
	private inFlight = 0;
	private completed = 0;
	private failed = 0;
	private drainTimer: unknown | null = null;

	constructor(opts: QueueOptions = {}) {
		this.tier = opts.tier ?? detectTier();
		this.rpmBudget = effectiveRpm(this.tier);
		this.now = opts.now ?? (() => Date.now());
		this.setTimeoutFn = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
		this.bucket = makeBucket(this.rpmBudget, this.now());
	}

	/** Submit a task. Returns a promise that resolves/rejects with the task's result. */
	submit<T>(run: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.pending.push({ run, resolve, reject } as Task<T>);
			this.drain();
		});
	}

	/** Submit many tasks and await them all. Resolves with an array in submit-order. */
	async submitAll<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
		return Promise.all(tasks.map((t) => this.submit(t)));
	}

	stats(): QueueStats {
		return {
			tier: this.tier.name,
			rpmBudget: this.rpmBudget,
			maxConcurrent: this.tier.maxConcurrent,
			inFlight: this.inFlight,
			queued: this.pending.length,
			completed: this.completed,
			failed: this.failed,
		};
	}

	private drain(): void {
		if (this.drainTimer !== null) return;
		this.drainInternal();
	}

	private drainInternal(): void {
		refill(this.bucket, this.now());
		while (
			this.pending.length > 0 &&
			this.inFlight < this.tier.maxConcurrent &&
			this.bucket.tokens >= 1
		) {
			const task = this.pending.shift()!;
			this.bucket.tokens -= 1;
			this.inFlight++;
			// Kick off the task; don't await here — that would serialize.
			task.run().then(
				(v) => {
					this.completed++;
					task.resolve(v);
				},
				(e) => {
					this.failed++;
					task.reject(e);
				},
			).finally(() => {
				this.inFlight--;
				this.drain();
			});
		}
		// If still pending, wait for the next token refill or in-flight slot.
		if (this.pending.length > 0 && this.drainTimer === null) {
			// Time until next token: (1 - tokens) / refillPerMs
			const msUntilToken = this.bucket.tokens >= 1 ? 0 : Math.ceil((1 - this.bucket.tokens) / this.bucket.refillPerMs);
			// If concurrency-bound instead, re-check on next in-flight completion (no timer).
			if (this.inFlight >= this.tier.maxConcurrent) return;
			// Schedule a single timer (not per-task; debounced).
			this.drainTimer = this.setTimeoutFn(() => {
				this.drainTimer = null;
				this.drainInternal();
			}, Math.max(10, msUntilToken));
		}
	}
}
