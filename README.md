# @getpie/pi-cliproxyapi-provider

Minimal [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) provider extension for [Pi](https://pi.dev).

- Uses official `@earendil-works/pi-ai` `openAICodexResponsesApi()` for persistent WebSocket + `previous_response_id` continuation (zero filesystem path probing or source patching).
- Supports `!command` (e.g. `!op read op://...`) and `$ENV_VAR` in `~/.pi/agent/cliproxyapi.json`.
- Discovers models from `{baseUrl}/v1/models?client_version=pi` and caches them in `~/.pi/agent/cliproxyapi-models.json`.

## Install

```bash
pi install npm:@getpie/pi-cliproxyapi-provider
# or
pi install git:github.com/getpie-dev/pi-cliproxyapi-provider
```

## Config (`~/.pi/agent/cliproxyapi.json`)

```json
{
  "baseUrl": "https://your-cpa-host:27119",
  "apiKey": "!op read op://dev/cliproxyapi/key",
  "providerId": "cpa",
  "providerName": "cpa"
}
```
