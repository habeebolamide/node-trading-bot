# Design: m7-shadow-predictions

## Ambiguity — do shadows feed the Brain?

Two options:
- **A** shadows feed `brain_setup_occurrence` + `brain_agent_occurrence` alongside real
  outcomes. Free data.
- **B** shadows are kept OUT of the Brain; §23 reads them from `prediction_outcome` directly
  and joins to `judge_decision` for grouping.

**Chosen: B.**

The Brain's Setup Memory decides what future SIGNAL SCORES look like via `historicalEdge`. If
shadow outcomes feed it, then a Judge that consistently FLIPs to the right direction bakes its
own preference back into the deterministic score the next signal reads — the Judge would
influence the deterministic engine through a back channel, exactly what §18's "narrow gate"
discipline exists to prevent. §33 rule 13 is about calculation; this is the same idea for
memory: the Brain is a shared domain fact, not something the LLM's picks steer indirectly.

The cost is real: we discard signal from paper trades that DID resolve. §23's shadow evaluation
absorbs it — it reads `prediction_outcome` directly, groups by `judge_decision.judgeAction`,
and compares win rates. That answers "does the Judge add value" without letting the Judge write
to the Brain.

**Enforcement:** the outcome-sweep's `feedBrainOnce` (M6 change 4) is extended to skip
`isShadow=true` predictions. One-line guard, tested by its own unit test that asserts
`recordSetupOutcome` was NOT called for a shadow.

## Shadow on `paper_position`

Adds `paper_position.is_shadow boolean NOT NULL DEFAULT false`. `openPositionCount(portfolioId)`
excludes shadows so a FLIP's real+shadow pair doesn't blow through `maxConcurrentPositions`.
That's the right meaning of the constraint anyway — it caps *live-money-equivalent* exposure;
a shadow is a measurement.

`paper_position_fill` and `paper_position_originating_wallet` inherit the shadow-ness via
`positionId`; no columns needed there.

## Handlers

### `signal.flipped` → REAL is Judge direction; add SHADOW for deterministic

```
handleSignalFlipped(event) {
  // Find the real prediction the gate already created (Judge direction, isShadow=false).
  const real = getPredictionBySignal(event.signalId);
  // Rerun the planner for the DETERMINISTIC direction — same view, same config.
  const shadowPlan = await planTrade(
    { symbol, domain: 'perp', direction: event.deterministicDirection },
    ctx,
  );
  if (shadowPlan.kind !== 'TRADE') return; // deterministic side would have failed R:R too; no shadow
  // Insert a shadow prediction via a DIRECT INSERT — createPrediction cannot help here because
  // the signal is already CONSUMED. Use INSERT with is_shadow=true, shadow_of=real.id.
  await insertShadowPrediction(...);
  // Open a shadow paper position that opens alongside the real one.
  await openPosition({ ..., is_shadow: true });
}
```

The trigger (M6 change 2) allows INSERTs; the immutability rule applies to UPDATE/DELETE, so a
direct insert of a shadow prediction is fine — same audit-trail discipline as every other
prediction.

### `signal.stood_aside` → SHADOW only

Same as above, but there's no real to peg `shadow_of` against. The row has `isShadow=true`,
`shadowOf=null`. The gate stamped `judgeAction=STAND_ASIDE` on the Judge's `signal_feature`
row — that's the join key for §23 reports.

## Reporting

```ts
compareShadowVsReal(db, configVersion, asOf) → {
  flipRealGroup:   { n, winRate, medianReturn, maxDrawdown }
  flipShadowGroup: { n, winRate, medianReturn, maxDrawdown }
}
compareShadowVsBaseline(db, configVersion, asOf) → {
  standAsideShadowGroup: { n, winRate, medianReturn, maxDrawdown }
  baseline:              { n, winRate, medianReturn, maxDrawdown }  // all deterministic AGREE/DEFER predictions
}
```

Read from `prediction_outcome`, joined to `judge_decision` for grouping. NOT from the Brain,
per resolution above.

## Testing

- Brain never sees shadows: `recordSetupOutcome` is NOT called for `isShadow=true`; asserted by
  a spy in the sweep's own tests.
- `openPositionCount` excludes shadows — a FLIP that opens real+shadow does not push a
  `maxConcurrentPositions=1` portfolio into failure.
- `signal.flipped` where the deterministic side ALSO fails planTrade → NO shadow row, and the
  logs record the reason (parity with real's own NO_TRADE path).
- `signal.stood_aside` writes a shadow with `shadowOf=null` and `is_shadow=true`.
- `compareShadowVsReal` returns null groups when nothing has resolved (bootstrap-safe).
- Integration: a FLIP+resolve cycle produces two `prediction_outcome` rows (real + shadow) with
  distinguishable stats, and the compare helper reads both.
