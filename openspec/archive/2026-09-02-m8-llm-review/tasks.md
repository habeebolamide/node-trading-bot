# Tasks: m8-llm-review

`[x]` done — dashboard builds; Prediction detail with attribution + Judge + autopsy inline; Autopsies browser + Hypotheses queue + Shadow evaluation panels.

- [x] Prediction list + detail; detail shows setup, Judge decision + thesis/keyRisks, per-agent attribution (§22), Risk verdict, and autopsy inline if present
- [x] Autopsies browser with status/outcome filters; FAILED_LLM rows show the retry hint (retry is an operator CLI action)
- [x] Hypotheses queue with status filter; row shows setup/category/kind/effective-n/change; NO promote button — the queue displays candidates + evidence, promotion is CLI-only
- [x] Shadow evaluation panels — compareShadowVsReal + compareShadowVsBaseline per agent
- [x] typecheck + vite build green (315kB / 96kB gzip)
