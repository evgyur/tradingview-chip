# TradingView Chip permission manifest

## Identity and default mode

Skill: `tradingview-chip`. Skill files live in this directory after installation; the MCP source and private runtime can live elsewhere. The operator owns the connected TradingView account. Default mode is read-only discovery. This skill cannot authorize actions by itself.

## Allowed tools and files

Use the reviewed local TradingView Chip MCP domain tools, its tool catalog, health checks, and requested local exports. Read the relevant skill references and repository validation records. Use private runtime checkpoints for recovery. Generic UI requires a specific task need and exact target/layout guards; no caller-provided JavaScript or arbitrary request wrapper is an approved interface.

## Allowed network surface

The server connects to a literal loopback CDP endpoint. Reviewed adapters use fixed TradingView HTTPS endpoints, including `www.tradingview.com`, `pine-facade.tradingview.com`, `pricealerts.tradingview.com`, `scanner.tradingview.com`, and `symbol-search.tradingview.com`. Consult the current implementation allowlists for the exact supported endpoints; this manifest does not expand them. Account reads remain in the signed-in browser context. Optional public scanner/community requests omit account credentials. Source and official-documentation lookup may be used as evidence.

## Authorized mutations

The user's explicit task can authorize specified chart, layout, drawing, Pine, watchlist, alert, replay, or local simulation changes on identified targets. Preserve that scope across reconnects. An approval of a described action covers its described target and effects; generic continuation never grants unspecified new effects. Alert activation, possible temporary activation, webhook configuration, and simulation need their actual effects understood within that scope.

Resolve dynamic IDs through authenticated readback and match them to the intended object before changing or deleting it. Require `target_id`, `expected_layout_id`, current source/version/hash preconditions where supported, durable creation keys, and post-action readback. On ambiguity or unknown state, fail closed and reconcile rather than widening access.

## Forbidden actions

Never place, cancel, or close real broker orders; change leverage or margin; fund, withdraw, or transfer assets; sign wallet transactions; grant financial approvals; or create/rotate/revoke API keys or login sessions. Do not use a broker, wallet, exchange mutation endpoint, or raw action surface as a read-only probe. Never expose CDP to a remote host, extract browser credentials, bypass save/identity guards, or automatically retry an uncertain write with a new key.

## Secrets and private data

No TradingView password, cookie export, browser session, wallet key, or third-party AI credential is required. Login happens directly in the user's app. Never request, print, persist in source, or publish secrets. Keep browser profiles, auth files, private Pine source, webhook URLs containing secrets, runtime payloads, account screenshots, and account identifiers out of public artifacts. If sensitive material is exposed, stop further disclosure and report the affected artifact without repeating the value; credential rotation belongs to the operator's separate authorized process.

## Output and verification

Label the result as read, prepared, changed/verified, simulation, failed, or unverified. Cite the exact kind of readback used. Never claim alert delivery from configuration checks, successful compilation from light validation, full copy fidelity from partial state, or live trading from simulation. Include an existing object ID and recovery instruction for uncertain writes without disclosing private payloads.

## Regression probes

Run `node scripts/validate-skill.mjs` and `node --test tests/skill-contract.test.mjs` from the source repository root. The tests require target guards, idempotent reconciliation, the real-broker prohibition, credential boundaries, and truthful validation states; negative fixtures must fail when a critical rule is removed or unsafe permission is introduced.
