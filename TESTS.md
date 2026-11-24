# Verification record — 2026-11-24

Tested the shipped workflow with n8n CLI 2.20.0 (official Linux image filesystem and JavaScript runner), a fresh SQLite profile, Python 3.12.14 and a local HTTP mock. No real Google or store accounts. Node.js v24.22.3 ran 14 programmatic tests. Actual commands are in README. Raw outcomes: [unit](tests/results/unit.txt), [engine](tests/results/engine.txt).

| Real engine execution | Observed outcome |
|---|---|
| Initial sync, 429 and lost write acknowledgement | Five successful pages, 250 added, zero failed. Wait observed at least 1.95 seconds for Retry-After: 2. Exactly seven batch write requests including the disconnected request. Reconciliation found its committed rows. |
| Immediate fresh execution | 250 skipped, zero writes. |
| Changed order, invalid record, three pre-commit 503s | 249 skipped, one validation error, one unresolved order, exactly three writes. |
| Fresh execution after fault clears | One updated at the original address, 249 skipped, one still invalid, exactly 250 order rows retained. |
| Source returns 403 | One request only, aborted report, no destination writes. |

All five execution assertions passed after fixing the integration defect: in text response mode n8n 2.20.0 exposed the HTTP payload in data. The first test run stopped at invalid_page after a successful retry. The released response adapter handles data and body, and parses JSON after capturing the HTTP status.

The 14 programmatic tests cover the graph and export, empty and paginated feeds, cursor cycles and ceilings, schema failures, date validation, duplicate source and destination keys, fixed-row upserts, ambiguous and partial acknowledgement, unexpected destination changes, bounded retries, Retry-After in both formats, 401/403 and batch rejection isolation. They exercise the transition source and verify it is embedded in the release.

Not exercised: live Google OAuth, actual Sheets quotas and grid sizing, real store pagination stability, the n8n GUI, calendar triggering, long waits across an n8n process restart, simultaneous writers, or production-scale load. Recovery was tested by fresh CLI executions against the same mock dataset. Single-writer operation is a deployment condition, not an implemented distributed lock.

## Author-reported local checks — 2026-11-24

The author exercised the workflow in a local Node.js-based n8n installation with mock REST and Sheets services. Local version numbers and raw traces were not supplied. The committed CLI logs above belong to the separate automated suite.

| Check | Observed by the author |
|---|---|
| Pagination | Retrieved 250 orders across five pages. |
| Initial synchronization | Loaded the initial dataset successfully. |
| Idempotency | A repeat run produced no duplicate orders. |
| Rate limiting | Handled a simulated 429. |
| Interrupted write | Recovered after losing the connection during persistence. |
| Authentication failure | Stopped on a simulated 403. |
| Upsert | Updated one order and skipped 249, preserving unique rows. |
