# Metadata documentation

The metadata system is documented in three focused references:

- [Data model](data-model.md): entity boundaries, cardinalities, identity, and ordering.
- [Metadata pipeline](metadata-pipeline.md): queueing, Spotify hydration, LLM parsing, reconciliation, and production execution.
- [Metadata quality](metadata-quality.md): invariants, review semantics, validation, repair procedure, and the current production snapshot.

The physical table names ending in `_v2` are historical. They are the canonical production tables. The legacy `movement`, `track_movement`, and `recording` tables no longer exist in production even though some compatibility declarations may remain in application code.
