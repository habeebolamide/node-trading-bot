# OpenSpec — how change proposals work in this repo

This is the **execution** layer. The master plan resolves *architecture* (the what and why,
once); OpenSpec change specs resolve *execution* (how, in what order, tested how). Change specs
reference plan sections by number — they never duplicate them.

Full rules live in [`../CLAUDE.md`](../CLAUDE.md) ("Workflow: OpenSpec"). This file is the
quick reference.

## Folders

```
specs/     source-of-truth capability specs (what the system does, once built & stable)
changes/   in-flight change proposals — one folder per feature/subsystem
archive/   completed changes, permanent audit trail (dated)
```

## A change folder

```
changes/<change-name>/
  proposal.md   what's changing, why, which plan sections it implements
  design.md     concrete design choices, cross-referencing the plan
  tasks.md      checklist of implementation steps + tests (this is session continuity)
  specs/        (optional) capability spec added/modified by this change
```

## The cycle

1. **PROPOSE** — write the change folder above.
2. **REVIEW** — short (architecture is already resolved in the plan). Does the task list cover
   the plan's requirements? Are tests aimed at the right invariants? Any ambiguity resolved
   solo that needs sign-off?
3. **IMPLEMENT** — work `tasks.md`, checking items off. If the design must change mid-flight,
   update `design.md` in the same PR — no silent drift.
4. **ARCHIVE** — move the folder to `archive/<date>-<change-name>/` with a completion summary
   appended to `proposal.md`. **Archiving is part of "done" — same PR.** Skipping it is how the
   workflow decays.

## When to create a change vs. just PR

- **Create a change**: new subsystem, new Analysis Agent, multi-table migration, the
  seed-history analysis pass, anything you'd start by thinking "how do I do this before I
  write it."
- **Skip (just PR)**: bug fixes, renames, formatting, config-value tweaks, anything under an
  hour with a self-evident implementation.

The scope rule: **is there a design question worth writing down before code?** Yes → OpenSpec.

## Continuity across sessions

A fresh session starts by reading: `CLAUDE.md` → the relevant plan sections → the active
`changes/<name>/tasks.md` (exactly where the last session left off). Do not re-derive state
from git log.
