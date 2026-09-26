import { IntentBudgetRemaining } from "./Agent";

// Mirrors src/server/ClientMsgRateLimiter.ts. An agent tuned against these
// numbers offline never has an intent silently dropped by a real server.
export const INTENTS_PER_SECOND = 10;
export const INTENTS_PER_MINUTE = 150;
/** The server kicks for an intent frame larger than this. */
export const MAX_INTENT_BYTES = 2000;

/**
 * One interval of the `limiter` package's RateLimiter, which the server uses:
 * a token bucket (capacity N, refilled continuously at N per interval) plus a
 * fixed window that allows at most N removals per interval. Time is passed
 * in, in milliseconds, so the arena can drive it from game ticks and the
 * browser from the wall clock.
 */
class IntervalLimiter {
  private content: number;
  private lastDripMs: number;
  private windowStartMs: number;
  private usedInWindow = 0;

  constructor(
    private readonly perInterval: number,
    private readonly intervalMs: number,
    nowMs: number,
  ) {
    this.content = perInterval;
    this.lastDripMs = nowMs;
    this.windowStartMs = nowMs;
  }

  private advance(nowMs: number): void {
    if (
      nowMs < this.windowStartMs ||
      nowMs - this.windowStartMs >= this.intervalMs
    ) {
      this.windowStartMs = nowMs;
      this.usedInWindow = 0;
    }
    const elapsed = nowMs - this.lastDripMs;
    if (elapsed > 0) {
      this.content = Math.min(
        this.perInterval,
        this.content + (elapsed * this.perInterval) / this.intervalMs,
      );
    }
    this.lastDripMs = nowMs;
  }

  available(nowMs: number): number {
    this.advance(nowMs);
    return Math.max(
      0,
      Math.min(Math.floor(this.content), this.perInterval - this.usedInWindow),
    );
  }

  take(): void {
    this.content -= 1;
    this.usedInWindow += 1;
  }
}

/**
 * Client-side copy of the server's per-client intent limits. Unlike the
 * server, it checks both limits before consuming either, so a send that
 * would be refused never burns a token.
 */
export class IntentBudget {
  private perSecond: IntervalLimiter;
  private perMinute: IntervalLimiter;

  constructor(
    private readonly nowMs: () => number,
    private readonly enabled = true,
  ) {
    const start = nowMs();
    this.perSecond = new IntervalLimiter(INTENTS_PER_SECOND, 1000, start);
    this.perMinute = new IntervalLimiter(INTENTS_PER_MINUTE, 60_000, start);
  }

  remaining(): IntentBudgetRemaining {
    if (!this.enabled) {
      return { perSecond: Infinity, perMinute: Infinity };
    }
    const now = this.nowMs();
    return {
      perSecond: this.perSecond.available(now),
      perMinute: this.perMinute.available(now),
    };
  }

  /** Consumes one intent's worth of budget if both limits allow it. */
  tryConsume(): boolean {
    if (!this.enabled) {
      return true;
    }
    const { perSecond, perMinute } = this.remaining();
    if (perSecond < 1 || perMinute < 1) {
      return false;
    }
    this.perSecond.take();
    this.perMinute.take();
    return true;
  }
}
