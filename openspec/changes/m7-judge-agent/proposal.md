# Change: m7-judge-agent

**Status:** PROPOSED (scoping)
**Milestone:** M7 (change 2 of 6)
**Implements:** §18 (Judge synthesis + independent direction/confidence) · §40.14 Judge Agent
(LLM, perp-only in MVP) · §33 rules 13, 14 · §36 (signal lifecycle interaction)

## What's changing

The Judge itself — the LLM that synthesizes structured evidence into a thesis and its OWN
direction/confidence read. The FLIP/STAND_ASIDE/DEFER gate that consumes that read is change 3;
this change just produces the input.

1. **Judge agent** (`packages/agents/src/perp/judge.ts`) — EVENT trigger on `signal.created` when
   `signal_risk.risk_level != 'INVALIDATED'` (§40.14: "Risk INVALIDATED short-circuits").
2. **Structured evidence assembly** — reads the finished Signal + `signal_feature` rows M4
   persists + `signal_risk` + the Brain's `historicalEdge` (M5). NO raw market data goes into
   the prompt (rule 14 — the LLM cannot invent facts, so it reasons only over facts we hand it).
3. **Prompt** — a short, versioned system prompt plus a JSON user message. Both stored as
   constants keyed by `judgeVersion` so a prompt change is a version bump, comparable in every
   §23 metric and every §22 attribution without silent drift.
4. **Response Zod schema** — the §40.14 output: `{ direction, confidence, thesis, keyRisks,
   invalidators, confidenceTag }`. `judgeAction` is NOT here — that is computed by the gate
   (change 3) and stamped later.
5. **Emits** `judge.evaluation.completed` carrying the Judge's raw output + the source
   `signalId` so change 3 can join.
6. **Memecoin refused** (§40.14 memecoin note) — a memecoin signal short-circuits with no LLM
   call, no cost incurred. Silent skip would hide the mismatch; the domain check throws to make
   it visible in review.
7. **LLM failure = null output.** §18: "the prediction must still be created, deterministic-only."
   A failed Judge call produces NO Judge event; the gate (change 3) sees no event, defers, the
   downstream Prediction is deterministic. Structural graceful degradation.

## What this change does NOT do

- **No prediction creation.** The Prediction is created by the change-3 gate consumer, which
  either flips direction or stamps the deterministic call.
- **No composite scoring.** Rule 13 absolute — the Judge's `confidence` and `direction` never
  enter `composeSignal` and never edit weights.
- **No memecoin autopsy** (§24 memecoin deferral) — memecoin has no historical backtest so
  autopsy hypotheses would have no promotion path.

## Ambiguity resolved (needs sign-off)

**§40.14 says the Judge output includes `invalidators` as structured objects
(`{ type: 'price_above', value: 67200 }`) but never enumerates the vocabulary.** Two options
considered:
- **A** free-form: the LLM invents `type` strings; caller parses whatever comes back
- **B** closed enum: schema restricts `type` to a known set the paper engine can act on
Resolution: **B** — a `type` string the paper engine cannot act on is invalidator-shaped and
worthless. The initial vocabulary is `price_above | price_below | ttl_expired | funding_extreme
| stop_moved`; extending it is a `judgeVersion` bump.
