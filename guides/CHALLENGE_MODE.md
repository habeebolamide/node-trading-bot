# Challenge Mode

A time-boxed "flip the account" mode where one of your agents trades an isolated stake (e.g. **$4 → $40 in 30 days**) while the rest of your account keeps doing its normal thing. Pass, fail, or expire — when it ends, the bucket folds back into the main account and the agent pauses.

This guide explains what it is, how to start one, the math behind the bucket, every way a challenge can fail, and the realistic gotchas (fees, funding, min order sizes) you need to know before you risk real money.

---

## Table of contents

1. [What it is and when to use it](#1-what-it-is-and-when-to-use-it)
2. [Quick start](#2-quick-start)
3. [The bucket model](#3-the-bucket-model)
4. [Position sizing inside the bucket](#4-position-sizing-inside-the-bucket)
5. [The nine pre-flight checks](#5-the-nine-pre-flight-checks)
6. [Mid-session failure modes](#6-mid-session-failure-modes)
7. [Reading the session row](#7-reading-the-session-row)
8. [Realistic expectations: fees, funding, min notional](#8-realistic-expectations-fees-funding-min-notional)
9. [Safety: paper mode first](#9-safety-paper-mode-first)
10. [FAQ](#10-faq)

---

## 1. What it is and when to use it

A **challenge** is a self-contained trading session attached to a single agent. You set three numbers up front:

- **Starting capital** — how much you're putting into the bucket (e.g. $4).
- **Target capital** — what you're trying to hit (e.g. $40).
- **Duration** — how long you have (e.g. 30 days).

While the session is active, that agent only trades within the bucket. Its P&L, drawdown, and decisions are scoped to those starting dollars — not your full account. When the session ends (you hit the target, blow up, or run out of time), the bucket's final equity folds back into your main account and the agent goes to sleep.

**Good reasons to use it:**

- You want to test an aggressive strategy without risking the whole account.
- You want a clear, time-boxed performance benchmark for an agent.
- You only have $4 in Bybit and you want the whole thing on a challenge — works the same.

**Bad reasons to use it:**

- You're trying to "make trading more fun" — challenges are still real risk.
- You expect huge returns to be the norm — they're statistically rare; the cap is 10× by design.

---

## 2. Quick start

Challenge config lives on a `ChallengeSession` row. The `Agent` row only carries one field — `challengeMode` — which is the start/stop toggle. Two steps:

### Step 1 — create a pending session

Open Prisma Studio (`npx prisma studio`) → `challenge_sessions` table → New row. Fill in:

| Field             | Required | Example  | What it does                                            |
|-------------------|----------|----------|---------------------------------------------------------|
| `agentId`         | yes      | (pick one) | Which agent runs this challenge                        |
| `startingCapital` | yes      | `4`      | Dollars the bucket starts with                          |
| `targetCapital`   | yes      | `40`     | Pass threshold                                          |
| `durationDays`    | no (30)  | `30`     | How long the challenge runs once activated              |
| `riskPercent`     | no (10)  | `10`     | % of current bucket equity risked per trade             |
| ~~`leverage`~~    | —        | —        | **Removed** — leverage comes from the agent's `leverage` column. Edit it on the agent before starting the challenge. |
| `maxDrawdownPct`  | no (0.5) | `0.5`    | Bucket dies if equity drops by this fraction (50% → $2) |
| `executionMode`   | no (paper) | `paper` or `live` | Paper sim vs real Bybit orders                |
| `status`          | no (pending) | leave default | New rows default to `pending` — don't change |

Save. The row sits in `pending` state — nothing happens yet.

### Step 2 — flip the toggle

On the agent, set `challengeMode = true`. Save.

Within ~60 seconds the bot's reconciler will:

1. Find your latest pending session for that agent.
2. Run pre-flight checks (see [§5](#5-the-nine-pre-flight-checks)).
3. If everything passes, flip the session to `status='active'`, set `startsAt` + `endsAt`, send a Telegram alert, and start trading the bucket.
4. If anything fails, flip the session to `status='failed'` with `failReason` populated, flip `challengeMode` back to false, and send a start-failed alert.

> If the agent's `status` is `paused`, it gets auto-resumed to `active` as part of activation. You don't need to unpause manually.
>
> If the agent has an **open non-challenge trade**, activation is rejected (`AGENT_HAS_OPEN_TRADE`) — wait for that trade to close first.

### Step 3 — end it

Three ways:

- **Auto** — bucket hits the target (pass), drawdown floor (fail), min-viable equity (fail), or expiry.
- **Manual** — set `challengeMode = false` while the session is active. Status becomes `cancelled`.
- Either way, the agent gets paused, the bucket's realised P&L folds back into the main account, and the session row stays around in history.

### Running another challenge

Create another `pending` session row (with the same or different config) and toggle `challengeMode=true` again. The old session row stays untouched as history.

---

## 3. The bucket model

This is the part most people get stuck on. The challenge is **isolated** — the rest of your account doesn't see its swings, and the bucket doesn't see the rest of your account's swings. It's done with a **frozen carve-out**, not by physically moving money on Bybit.

### Plain English

```
You have $X in Bybit.
You start a challenge with starting capital $C.

While the challenge is active:
  - The challenge bucket has its own equity: starts at $C, moves with challenge trades only.
  - Other agents see "main pool" = $X − $C  (frozen at the value of $C at start)
  - Other agents do NOT see challenge wins/losses. They don't shift.

When the challenge ends:
  - Bucket's final equity folds back: main pool = $X − $C + finalBucketEquity
  - No transfer happens — it's just accounting flipping a filter.
```

### Two scenarios

**Scenario A: You have $4 total, challenge takes all of it.**

| Field                  | Value |
|------------------------|-------|
| `rawAccountTotal`      | $4    |
| `startingCapital`      | $4    |
| `mainPool.totalValue`  | **$0** — other agents have nothing to trade |
| `challengeBucket`      | $4    |

Other agents just sit idle. The whole account is in the challenge. This is allowed and intentional.

**Scenario B: You have $20, challenge takes $4.**

| Field                  | Value |
|------------------------|-------|
| `rawAccountTotal`      | $20   |
| `startingCapital`      | $4    |
| `mainPool.totalValue`  | $16 — other agents trade normally on this |
| `challengeBucket`      | $4    |

Other agents see $16 and size their positions off that. They will not see anything shift just because the challenge took a $0.40 loss.

### Why frozen, not live?

If other agents saw `mainPool = rawTotal − liveChallengeEquity`, then every challenge trade would ripple into other agents' position sizing. A small bucket having a great day would shrink everyone else's positions in real time. That's noisy and confusing.

By freezing the carve-out at `startingCapital`, the main pool stays stable. Wins and losses inside the bucket stay inside the bucket until termination.

---

## 4. Position sizing inside the bucket

The challenge has its own sizing formula. It does **not** use the agent's normal `allocationPercent × portfolio.totalValue` math.

```
challengeEquity = currentBucketEquity (compounds with wins, shrinks with losses)

notionalCap = challengeEquity × session.leverage
maxRisk     = challengeEquity × (session.riskPercent / 100)

positionSize = min(notionalCap / entry,
                   maxRisk     / |entry − stopLoss|)
```

### Worked example

- Bucket equity: **$4**
- Leverage: **10×** → notional cap = $40
- Risk per trade: **10%** → maxRisk = $0.40
- Signal: BTC at $100, stop at $99 (1% stop distance)

```
size = min($40 / $100,  $0.40 / $1)
     = min(0.4,  0.4)
     = 0.4 units of BTC
```

Notional = `0.4 × $100 = $40`. If the stop hits, loss = `0.4 × $1 = $0.40`, which is 10% of the $4 bucket. Matches the configured risk.

### Compounding

Each entry recomputes `challengeEquity` from the bucket's realised + unrealised P&L. Win a trade and go from $4 to $4.40 → next trade sizes off $4.40 (notional cap = $44, risk = $0.44). Lose and you size off the smaller equity.

This is the whole point of "flipping" — the bucket grows geometrically when you win.

### Why these caps?

- **Notional cap** keeps you from getting margin-called: `equity × leverage` is exactly the position the exchange will let you hold.
- **Risk cap** stops one bad trade from eating most of the bucket. With a 10% risk, you need 10 losing trades in a row to fail by drawdown alone.

---

## 5. The nine pre-flight checks

These all run inside `startChallenge()` **before** any session row is created. If any one fails, `challengeMode` flips back to false and you get a notification.

| # | Check | Code | Example | How to fix |
|---|-------|------|---------|------------|
| 1 | No pending session row for this agent | `NO_PENDING_SESSION` | You flipped `challengeMode=true` without creating a pending session first | Create a `ChallengeSession` row in Prisma Studio with `status='pending'` and your config, then toggle again. |
| 2 | `startingCapital < $4` | `BELOW_MIN_START` | Pending session has `startingCapital=3` | Use at least $4. (Floor will rise to $5 once the feature is past initial testing.) |
| 3 | `startingCapital × leverage < $5` | `BUCKET_TOO_SMALL_FOR_LEVERAGE` | $0.40 × 10× = $4 < $5 min notional | Raise `startingCapital` or `leverage` so their product clears the $5 floor. |
| 4 | `target ≤ startingCapital` | `INVALID_TARGET` | `target=4, start=4` | Target has to be strictly greater than start. |
| 5 | `target > startingCapital × 10` | `TARGET_EXCEEDS_MAX_MULTIPLIER` | `start=4, target=45` (>$40) | The max multiplier is 10×. $4 → max $40. Lower the target. |
| 6 | `durationDays < 1` | `INVALID_DURATION` | `durationDays=0` | Set at least 1 day. |
| 7 | Another active session for this agent | `SESSION_ALREADY_ACTIVE` | You already have one running | End the active session first (toggle off, or wait for it to terminate). |
| 8 | Agent has an open non-challenge trade | `AGENT_HAS_OPEN_TRADE` | Agent state is `IN_TRADE` with a main-pool position | Wait for the open trade to close (naturally or manually), then toggle on. Prevents weird accounting where the old trade closes into main while the bucket runs separately. |
| 9 | `accountTotal < startingCapital` | `INSUFFICIENT_FUNDS` | $2 in Bybit, challenge wants $4 | Top up Bybit, or lower `startingCapital`. Equal is fine ($4 + $4 = full-account challenge). |

> **Note**: when any check 2–9 fails, the pending session row is flipped to `status='failed'` with `failReason` populated — you can see exactly why in Prisma Studio. To retry, create a fresh pending row (or edit the failed one back to `pending` after fixing the issue).

> **Why min start of $4?** Below this the bucket can't realistically clear Bybit's $5 min notional even at 10× leverage, and trading fees swamp the math. $5 is the eventual floor; $4 is a temporary lower bound for initial testing.
>
> **Why 10× max multiplier?** Targets above 10× are unrealistic enough that the system stops you from picking one. The 10× cap is the only gate on how ambitious the target can be — duration is left entirely to you. A challenge is *aspirational*, so if you want to point the bot at $4 → $40 in a short window and let it try its best, that's allowed. Hitting the target isn't compulsory; failing is a normal outcome.

---

## 6. Mid-session failure modes

Once a challenge is live, here's every way it can end:

### Pass — `status: 'passed'`

Bucket equity reaches `targetCapital` (realised + open). Triggered on each trade close and each hourly tick. Notification fires; agent pauses; capital folds back.

### Fail by drawdown — `status: 'failed', failReason: 'Drawdown floor breached'`

Bucket equity (**realized + unrealized**) drops below `startingCapital × (1 - maxDdPct)`. Default 50% → $2 floor on a $4 bucket.

This is evaluated **live**, not just on close. If the open trade's unrealized P&L drops the bucket below the floor, the trade is **force-closed immediately at market** with reason `DRAWDOWN_FLOOR` and the session flips to `failed`. The bucket cannot bleed past the floor even within a single losing trade.

Checked on every price update for the open trade's symbol (piggybacks on the existing TP/SL check path), plus on each trade close and each hourly tick as a backstop.

### Fail by unwinnable equity — `status: 'failed', failReason: 'Below minimum viable equity'`

Bucket equity has dropped so low that even a max-leveraged trade can't clear the $5 min notional. The bucket is effectively un-tradable from here; ending early is more honest than letting it drift. Triggered on each tick.

### Expired — `status: 'expired'`

The clock ran out (`endsAt < now()`). Whatever the equity is, that's the final result. Triggered hourly.

### Cancelled — `status: 'cancelled'`

You manually flipped `challengeMode = false` while the session was still active. Reconciler ends it with this status. Final equity is whatever it was at the moment of cancellation. Open trades are force-closed.

### Per-trade rejections (non-terminal)

Some checks reject a single signal without killing the whole session:

- **Per-trade min notional**: a specific signal would size below $5 notional. Skipped, session continues.
- **Standard risk validation** (correlation, R/R floor, confidence floor, etc.): same as for regular agent trades, just with challenge-scoped drawdown numbers.

These don't end the challenge. They just mean that particular setup didn't make the cut.

---

## 7. Reading the session row

Once a session starts, the row in `challenge_sessions` is the source of truth. Useful fields:

| Field             | What it tells you |
|-------------------|-------------------|
| `status`          | `active` / `passed` / `failed` / `expired` / `cancelled` |
| `failReason`      | Set on `failed`: e.g. `"Drawdown floor breached"` or `"Below minimum viable equity"` |
| `startingCapital` | What the bucket started with (immutable after session start) |
| `targetCapital`   | The pass threshold |
| `endsAt`          | When the session expires |
| `endedAt`         | When the session actually terminated (any terminal status) |
| `finalEquity`     | Bucket equity at termination |
| `finalReturnPct`  | `(finalEquity / startingCapital - 1) × 100` |
| `result`          | JSON blob with extras: trade count, win rate, etc. |

To find an agent's history: `SELECT * FROM challenge_sessions WHERE agentId = '...' ORDER BY createdAt DESC`.

To find all trades from a specific challenge: `SELECT * FROM trades WHERE challengeId = '...'`.

---

## 8. Realistic expectations: fees, funding, min notional

This is the unglamorous part. Read it before assuming you'll flip $4 to $48 in a month.

### Bybit trading fees

Bybit linear perp fees (USDT-margined):

- **Taker**: ~0.055% of notional per side
- **Maker**: ~0.02% of notional per side

A $40-notional taker round-trip (entry + exit) = `2 × 0.055% × $40 = $0.044`. That's **1.1% of a $4 bucket per trade** just in fees.

If you need ~10 wins to go from $4 to $48 (and assuming half of all trades are losses), you're looking at ~20 trades total = ~$0.88 in fees. That's 22% of the starting bucket eaten by fees alone.

> **Bybit reports `realizedPnL` net of fees**, so you don't have to subtract them manually — but you do have to factor them into how realistic your target is.

### Funding fees on perps

Perp positions held across funding intervals (Bybit: every 8 hours) pay or receive a small funding rate. Typical: ±0.01% of position value per interval. On a $40 position, that's ±$0.004 per 8 hours. Small per-event but adds up if you hold positions for days.

**Practical impact**: if your strategy holds positions for hours not days, funding is negligible. If it holds for days, factor in roughly 0.03% per day per side.

### Min notional gotchas

Bybit linear perps have a $5 minimum notional. If the bucket drops below `$5 / leverage` (e.g. $0.50 at 10×), no trade can be placed. The session will fail with `Below minimum viable equity` rather than dragging on. This is by design.

### Slippage

For pairs like BTC/USDT or ETH/USDT, slippage on $40 notional is essentially nothing. For exotic alts, it can be meaningful. Default to majors for challenge mode.

---

## 9. Safety: paper mode first

Before you point this at real money, run the 20-step smoke test in paper mode. The full list is in the implementation plan (`.claude/plans/let-s-go-into-plan-resilient-nebula.md`), but the critical ones:

1. **Migration** completed cleanly.
2. **All nine pre-flight rejections** trigger correctly (test each one with a deliberately bad config).
3. **Full-account challenge** ($4 → $20 with `INITIAL_CAPITAL=4`) works — main pool correctly shows $0.
4. **Slice challenge** ($4 → $20 with `INITIAL_CAPITAL=20`) works — main pool correctly shows $16.
5. **Pass / fail / expired / cancelled** — all four terminal states fire correctly.
6. **Mode routing** — a paper-mode challenge on a live-mode agent does not place real orders. **Verify before going live.**
7. **Restart safety** — kill the bot mid-session, restart, confirm reconciler resumes the existing session without duplicating it.

Only after all 20 pass should you flip `challengeMode = true` on a real live agent.

---

## 10. FAQ

### Can I run multiple challenges at once?

**Strictly one challenge per agent at a time** — this is enforced by the `SESSION_ALREADY_ACTIVE` pre-flight check, which inspects `Agent.currentChallengeSessionId`. If that field is non-null, attempting to start another session on the same agent is rejected and `challengeMode` flips back to false.

Different agents *can* run challenges in parallel. Each carve-out is independent and additive (the sum of all active `startingCapital` values is what gets excluded from the main pool). So if you have three agents and want each running a $4 challenge, that's $12 carved out total — fine as long as your account has at least $12.

### What happens if I top up Bybit mid-session?

Nothing directly. The session's `startingCapital` and `mainPool` carve-out are frozen at start. A top-up will show up in `mainPool.totalValue` (which is `rawAccountTotal − startingCapital`), so other agents will see more available — but the challenge bucket itself doesn't change.

### What if my Bybit balance *drops* mid-session (because other agents lose money)?

The challenge bucket's accounting equity is unaffected — it's still tracking its own trades. But if your *actual* Bybit balance drops below what the bucket needs to back its next order, Bybit will reject the order at the exchange. The `validateEntrySignal` min-notional check catches the obvious cases; the rest fall through to broker error. In paper mode this can't happen.

### Why $4 minimum starting capital?

Below this, the bucket can't reliably clear Bybit's $5 min notional even at high leverage, and fees swamp the bucket too fast to leave any real strategy edge. The eventual floor will be $5; $4 is a transitional lower bound during initial testing.

### Why a 10× max multiplier?

A 10× target on a 30-day timer requires roughly 8% compounded daily growth. That's already aggressive for a real strategy. Anything above 10× is in "delusional" territory and the system enforces the cap to stop you from picking a target you can't hit.

### Can I change the duration, target, or risk percent mid-session?

No. The session row snapshots these values at start. To change them, end the current session and start a new one (which resets the bucket equity to a fresh `startingCapital`).

### What if I want to top the bucket up mid-session?

Not supported. The whole point of an isolated bucket is that its starting capital is fixed. End the session and start a new one with a larger `startingCapital` if you want to retry with more.

### Does the challenge agent share signals/learning with my other agents?

The `TradeLesson` learning system is per-agent and orthogonal to challenges — challenge trades feed back into the agent's learning the same way regular trades do. If you want the lessons isolated, run the challenge on a dedicated agent.

### What happens to open trades when a challenge terminates?

They get force-closed at market. The trade close fires `evaluateChallenge` one more time (which is a no-op since the session is already terminal), and the realised P&L from that close lands in `finalEquity`.

### Where do I see notifications?

Wherever your existing trade notifications go (`utils/notifications.ts`). Three new notifications fire from challenges:

- `sendChallengeStarted` — session begins
- `sendChallengeStartFailed` — pre-flight rejection (tells you which check failed and the relevant numbers)
- `sendChallengeEnded` — terminal status with final equity and return %
