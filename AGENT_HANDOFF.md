# tradingview-chip agent handoff

This repository contains a local MCP server and the `skills/tradingview-chip` agent skill. The skill guides tool selection and verification; configure the MCP connection separately.

## First files

1. Read [README.md](README.md) for setup and environments.
2. Read [SKILL.md](skills/tradingview-chip/SKILL.md) and its permission manifest before operating a signed-in chart.
3. Use [docs/TOOLS.json](docs/TOOLS.json) for exact schemas and [docs/FEATURES.md](docs/FEATURES.md) for the catalog.
4. Read [Desktop qualification](docs/DESKTOP_VALIDATION_2026-11-20.md), [browser validation](docs/VALIDATION.md) and [SECURITY.md](SECURITY.md) for limitations.

## Install and connect

Clone this repository and use Node.js 24 or later. Copy the complete `skills/tradingview-chip` directory into your client's local skill directory. For Codex this is `~/.codex/skills/tradingview-chip`. Refresh skill discovery using the client's supported mechanism. Configure the server as described in README with `TV_READONLY=1`.

Launch the dedicated browser with `node src/cli.mjs launch`, or explicitly opt in to Windows MSIX Desktop with `node src/cli.mjs launch-desktop`. Desktop uses `http://127.0.0.1:9223`; the browser default is port 9222. Keep the selected environment explicit.

## Verify source before use

```bash
npm run check
npm run audit:source
npm test
npm run audit:release
```

The release audit examines the staged Git tree. Stage intended source files before running it in an unpublished checkout. Ordinary tests use fixtures and do not establish live account compatibility.

## First live calls

Start with `browser_list_tabs`, then `layout_get` on the selected exact `target_id`. Bind every mutation to that target and its actual native `expected_layout_id`. Read capabilities and inspect the requested state before writing. Use a disposable saved layout for qualification.

After any uncertain mutation, reconcile exact IDs and reuse its idempotency key. Do not create another object merely because a timeout occurred. Report observed results separately from unknown fields. Alert configuration does not prove delivery; light Pine validation does not prove compilation on a chart.

## Current boundaries

The project has 189 registered tools, with 105 available in read-only mode. Selected Desktop 3.5.1 chart/Pine/replay/template/screenshot operations were verified; every tool was not live-tested. Alert creation returned `invalid_request`, a three-pane Desktop copy passed the single-tab, loaded-chart, saved-layout and drawing-inventory checks, but full drawing-payload fidelity remains unverified. Preserve these limits until new evidence resolves them. Broker execution, cookie extraction, remote updaters and external Pine AI uploads are outside this workflow.
