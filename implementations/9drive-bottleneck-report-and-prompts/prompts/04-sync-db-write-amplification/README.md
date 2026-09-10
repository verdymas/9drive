# B4 — Sync DB Write Amplification

Goal: keep reconciliation semantics identical while making write volume proportional to actual changes plus pages, rather than total objects.

Phases:

1. Instrument and classify.
2. Batch safe writes.
3. Validate/enforce physical identity uniqueness if the data invariant holds.
