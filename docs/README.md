# docs

Working notes and decision records. The *architecture* itself lives in the master plan; this
folder holds the finer-grained material the plan defers to build time.

```
architecture/   diagrams, module boundaries, data-flow notes
agents/          per-agent implementation notes beyond the plan's §40 catalog
brain/           Brain math derivations, worked examples, calibration notes
scoring/         scoring-config rationale, weight-change history
research/        seed-history analysis outputs, provider evaluations
decisions/       ADRs — decisions made at build time that the plan left open
```

An ADR is warranted when a change resolves a plan-deferred question (schema shape, event
payloads, dashboard UX) in a way future work needs to know about. Keep them short: context,
decision, consequences.
