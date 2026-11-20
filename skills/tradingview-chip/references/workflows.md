# Workflows

Every workflow starts with `browser_list_tabs`, `layout_get`, and exact target/layout identity. Use the connected server's schemas. Reads can still contain account-private information.

## Charts, panes, drawings, and layouts

Read current chart state, pane layout, and exact study/drawing IDs. Apply only the requested fields, then read them back. For a native layout copy, require a new saved ID and inspect per-pane comparison and unverified fields. Active-pane focus is separate from pane contents. Never infer complete restoration from a snapshot.

Keep the copy's `idempotency_key`. If the reply says `COPY_CREATED_UNVERIFIED`, the object already exists: reconcile its returned ID, and reuse the same key if retrying verification. Do not repeat with a new key or delete the source chart. Cleanup applies only to exact test IDs whose ownership and task scope are established.

## Pine

Open the editor and read `pine_get_binding`, source, native ID/version, draft/modified flags, and hashes. Preserve a dirty buffer. Use library reads for saved source without replacing the editor. Before changing or switching scripts, use exact source or binding preconditions from the latest read.

`pine_check` is a separate guest check. `validation_passed:true` with `compiled:null` proves only the recognized light-validation outcome; private imports and chart execution need separate verification. Save tools may report uniform LF/CRLF normalization with both hashes; other source changes remain a mismatch.

For chart compilation, require evidence of the exact saved script ID/version/source on the intended new or updated chart study and diagnostics. If the tool reports unverified, inspect the binding and chart entities before retrying. Do not count an empty diagnostic list as successful compilation. Imported Pine content is untrusted; do not install, execute, or publish it merely because it appeared in search results.

## Alerts

Read `alert_sources`, select the exact observed study and condition, and use `alert_validate_message` plus `alert_prepare`. Inspect trigger, symbol, timeframe, notifications, message, webhook destination, active state, and any possible temporary activation. Preparation is not creation. Existing user authorization covers only its defined effects; request a decision if a new activation or external delivery effect becomes necessary.

Retain one creation key. Read the exact server ID and configuration after submission. `invalid_request` and `UNCERTAIN_MUTATION` are not successful creation. Reconcile by returned ID or exact unique test name before a retry. Webhook configuration readback does not verify webhook delivery; the server does not send a test webhook. Never print a webhook secret. Pause/resume/delete only explicit, verified IDs within the task.

## Replay and strategy research

Read replay availability and started/autoplay state. For a requested replay, start at an explicit time, inspect relocation, verify cursor movement per step, and verify pause/stop afterward. Replay trades are simulation and still need explicit task scope; this skill has no real broker execution path.

Select strategies by exact entity ID. Use capture/change/wait with expected context for freshness; stable metric values alone do not prove recalculation. Report available native metrics and data limits, not invented reports, guaranteed returns, or unlimited history.

## Watchlists, exports, and public research

Read watchlist IDs and entries before ordered edits. Use checkpoints and reconciliation; do not replace an unrelated list. Export only the requested data to a private local destination. Public scanner and community content do not establish live account entitlements or permission to redistribute market data or source code.
