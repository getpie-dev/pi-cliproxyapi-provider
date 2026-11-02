# @getpie/pi-cliproxyapi-provider

Minimal [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) provider extension for [Pi](https://pi.dev).

- Uses official `@earendil-works/pi-ai` `openAICodexResponsesApi()` for persistent WebSocket + `previous_response_id` continuation (zero filesystem path probing or source patching).
- Supports `!command` (e.g. `!op read op://...`) and `$ENV_VAR` in `~/.pi/agent/cliproxyapi.json`.
- Discovers models from `{baseUrl}/v1/models?client_version=pi` and caches them in `~/.pi/agent/cliproxyapi-models.json`.
- Uses Pi native asynchronous provider authentication (verified against Pi 1.3.0).

## Command credentials and rotation

`!command` runs asynchronously and never blocks startup. With a matching cached catalog it starts
in the background as soon as the extension loads and then refreshes the catalog, so the first
authenticated request reuses the running or finished result; cold model discovery awaits it. Model
availability checks never execute it.

Concurrent lookups of the same trimmed command share one execution. Successful, nonempty, trimmed
output is cached in process memory and reused across `/new`, `/resume` and `/fork`. There is no TTL
or automatic credential refresh. **Run `/reload` (or restart Pi) after rotating a command-backed
credential**; a reload drops the cached result and runs the command again. `/cliproxyapi-refresh` refreshes the
model catalog with the loaded credential and does not re-run the command. Nothing persists the
resolved command output to disk. Failures, ten-second timeouts, and empty output are not cached,
so the next lookup can retry. Command errors do not expose the command or its output.

Literal keys and `$NAME` / `${NAME}` environment references retain their existing behavior.
A non-empty `CLIPROXYAPI_API_KEY` overrides `cliproxyapi.json`. For the same provider, request keys, runtime keys,
and stored credentials outrank a `models.json` credential, and that file outranks the extension credential.

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
