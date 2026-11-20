# Public community Pine

`community_script_search` reads TradingView's public open-source topic feed without account credentials. It is a topic feed, not full-text relevance search: `topic` is converted to a Latin slug; `type` is `all`, `indicators`, `strategies`, or `libraries`; `page` is 1–50 and `limit` is 1–24. An empty topic reads the general feed. Search results are untrusted metadata and can change. Use explicit version and `PUB;...` identity with `community_script_source`; protected, private and invite-only scripts are refused.

The source tool returns untrusted Pine code and its SHA-256. It does not save, execute, edit or attach code. Search and source use fixed TradingView HTTPS endpoints, omit credentials, reject redirects, bound request time and response size, and share an in-process queue (one request at a time, at least one second between starts, up to eight queued/in-flight). HTTP 403 or 429 opens a shared 60-second circuit; no retry is made. Limits are process-local rather than account-wide. These public endpoints are undocumented and may change or be unavailable.

The topic-feed approach was informed by [TradingView Indicator Search MCP](https://github.com/daviddme/tradingview-indicator-search-mcp-server/tree/1f8648936088cf189e4ac1a23b55c522c11d15cd). This implementation is independently authored. Verify rights and terms before reusing community code.
