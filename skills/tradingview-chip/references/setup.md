# Setup and diagnostics

The skill supplies the operating procedure; the repository supplies the MCP server. Install Node.js 24 or later and inspect the source before running it. There are no npm dependencies to install. From the repository root, run `npm run check`, `npm run audit:source`, and the documented tests.

## Browser

Run `node src/cli.mjs launch` to start a dedicated browser profile and a loopback debugger at `http://127.0.0.1:9222`. Sign in directly in that browser and open a saved Superchart. Keep the profile private. This server uses local CDP; it does not require a browser extension or exported login cookies.

## Windows Desktop

Run `node src/cli.mjs launch-desktop`. The opt-in launcher supports the Windows MSIX installation and uses `http://127.0.0.1:9223`. It does not kill an existing app or bypass save prompts. If requested by the launcher, close the app normally after saving work, then launch again. Keep the intended chart tab active and the window restored for editor/screenshot work.

## MCP configuration

Configure a local stdio server with `command: node`, `args: ["/absolute/path/to/tradingview-chip/src/server.mjs"]`, and these environment settings:

```json
{
  "TV_CDP_ENDPOINT": "http://127.0.0.1:9222",
  "TV_DATA_DIR": "/absolute/path/to/private-runtime",
  "TV_READONLY": "1"
}
```

Use port 9223 for a separate Desktop connection. Use absolute paths and the actual Node executable if the client cannot find it. Restart the MCP connection after configuration changes. `TV_READONLY=1` is the default skill posture; expose mutation tools with `TV_READONLY=0` only for the defined task. The variable is a server configuration choice, not authorization for arbitrary mutations. Leave `TV_ENABLE_GENERIC_UI` unset unless specifically needed.

The runtime directory holds audit records, checkpoints, exports, and simulation state. Retain it for recovery; exclude it from public version control. The server does not read `.env` automatically and does not need a TradingView password or cookie in configuration.

Run `node src/cli.mjs doctor` with the chosen endpoint. Then use `browser_list_tabs` → `layout_get` → relevant state/capability reads. Follow paginated MCP tool lists and inspect schemas with `tools_catalog` rather than assuming names or parameters. If a capability is absent, report it; do not expose the debugger remotely or load an unreviewed third-party server.
