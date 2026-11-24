# Design and operating contract

## Decisions

One state item carries the source cursor, retry counter, canonical orders, queued writes and outcomes. Dispatch selects the next HTTP operation. Apply response retrieves the corresponding Dispatch item via n8n item linking and returns one paired item. Wait is entered only on a delayed retry or reconciliation. Run report is the final output for complete, partial and aborted runs. Inspect its status even if n8n marks the execution successful.

## Input and size

GET /orders?limit=50&cursor=... returns an object with an orders array and next_cursor (nonempty opaque string or null). The first cursor is empty. Follow only a token in the configured URL; never follow a URL supplied by a response. The source must offer stable pagination and a current snapshot. Missing next_cursor is a protocol failure, not end-of-data. A cycle or more than 100 requested pages stops before any sheet mutation. The mock honors the 50-record limit. This design holds the snapshot in memory and n8n can retain state copies at each step. It is intended for small stores, not unbounded feeds.

Managed columns, in order: `order_id, status, total_minor, currency, updated_at`. IDs are case-sensitive nonempty strings up to 80 ASCII identifier characters; status is paid/pending/cancelled/shipped. Amounts are nonnegative safe integers in minor currency units, currency a three-letter uppercase code and timestamps valid UTC calendar instants at whole-second precision. Invalid records enter the report, without storing the whole rejected payload. Identical repeats contribute to duplicateInputs; contradictory valid versions of an ID exclude that key and produce an error. A malformed occurrence is rejected independently. Absence from this feed does not delete a sheet row.

## Upsert

Read Orders!A1:E and build a map from ID to physical row. Duplicate keys or a damaged header stop processing. Compare all five normalized values. Skip exact matches, reuse the existing address for changes and allocate new addresses past the last returned row. Send up to 40 explicit one-row ranges in one values:batchUpdate with RAW values. A 400 on a batch causes individual isolation using the remaining attempt budget. Keep the five managed columns dedicated to this workflow. Do not put formulas, typed numeric IDs or unrelated records there. Sheets may reject addresses outside its preallocated grid.

## Retries and recovery

Transient network failures, 408, 425, 429 and 5xx use waits of at least 1 then 2 seconds, also honoring a longer Retry-After (seconds or HTTP date). Three total attempts per logical request within one execution, including the first. A verification GET has its own three-attempt read budget; it cannot reset the write budget. 401 and 403 abort immediately on every route. Repair credentials before starting another execution. Disable scheduling while repairing an authorization problem.

A missing response, transient write error or incomplete success acknowledgement triggers a fresh read. Confirm matching values, retry only outstanding original addresses, and abort if a target now contains unexpected data. On the third inconclusive write, verify once more; unresolved records whose previous value is still observed are reported as write_unconfirmed. If verifying itself fails, the run aborts. After a failed run clear the cause, wait for outstanding server operations to settle, then run manually. The next run rereads both snapshots. There is no append replay and no external retry queue. A full rerun is a new reconciliation with a fresh budget.

## Single writer and limits

Exclusivity is an operational prerequisite, not a lock. Permit exactly one execution against a destination at any time, including suspended Wait runs. No simultaneous manual, scheduled or retry runs. Do not sort, insert, delete or edit rows externally during a run or while an earlier write can still commit. On an uncertain crash, quiesce the writer and resolve outstanding requests before rerunning. Fixed addresses protect retries within a stable sheet. Sheets batch atomicity does not give a unique constraint on order_id, conditional writes or a transaction across read and write. If exclusivity cannot be guaranteed, use a transactional database with a unique key as the system of record. Source timestamps are part of equality; the source is authoritative, not version-merged.

## Reporting

added/updated count confirmed writes; skipped counts unchanged unique IDs. failed counts logged invalid occurrences, excluded conflicting IDs and individual write failures. Global problems appear separately in fatal. On abort, counts are partial and unprocessed records are unknown; zero failed is not proof of success. events holds transient attempt/HTTP status metadata. Save successful execution data to retain partial and aborted reports. Configure n8n retention and access for the sensitivity of the order data. No service credentials are included.

References: [batchUpdate](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchUpdate), [Sheets limits](https://developers.google.com/workspace/sheets/api/limits).
