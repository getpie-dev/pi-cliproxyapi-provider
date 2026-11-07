# @getpie/pi-cliproxyapi-provider

Minimal [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) provider extension for [Pi](https://pi.dev).

- Uses official `@earendil-works/pi-ai` transports: `openAICodexResponsesApi()` by default for persistent WebSocket + `previous_response_id` continuation, or `anthropicMessagesApi()` per endpoint (no source patching).
- Supports `!command` (e.g. `!op read op://...`) and `$ENV_VAR` in `~/.pi/agent/cliproxyapi.json`.
- Discovers models from `{baseUrl}/v1/models?client_version=pi` and caches them under `~/.pi/agent/`. One provider keeps `cliproxyapi-models.json`; each provider in a multi-provider config has its own cache file.
- Uses Pi native asynchronous provider authentication (tested against the locked Pi 1.3.0; APIs checked against installed Pi 1.5.0).

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
A non-empty `CLIPROXYAPI_API_KEY` overrides `cliproxyapi.json`, including every entry of an array.
For the same provider, request keys, runtime keys, and stored credentials outrank a `models.json` credential, and that file outranks the extension credential.

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

`api` accepts exactly `"openai-codex-responses"` (the default when omitted) or
`"anthropic-messages"`. Unsupported values skip that entry with a warning. There is no
`CLIPROXYAPI_API` override. An object and a one-entry array have identical defaults and environment rules.

For Anthropic Messages, use the CLIProxyAPI gateway host, optionally with a path prefix or trailing
`/v1`. The plugin supplies the gateway root to the native API, which appends `/v1/messages`; do not
set `baseUrl` to the full messages URL. Catalog discovery still uses that gateway’s `/v1/models`.
The resolved key goes through native Anthropic auth (`x-api-key` for ordinary API keys), with no
Codex JWT wrapping or account id. Codex keeps its existing `/backend-api/` routing and key wrapping.
Changing `api` invalidates incompatible cached model metadata; old untagged caches remain valid
only for Codex.

## Multiple endpoints

The file may instead be an array of those same objects. Each entry is registered as its own Pi provider.
Pi selects the provider. There is no load balancing, failover, or extra selector.
In the example below, `cpa` keeps default Codex behavior, while `tcpa` follows
**Pi → this plugin → tcpa CLIProxyAPI Anthropic Messages endpoint → GLM upstream**.
Configure GLM upstream routing in the gateway, not in this plugin; keep `tcpa` here, not in
`models.json`, and do not point it directly at Zhipu.

Use a distinct `providerId` for each entry (the default is `cpa`). A repeated id is skipped after a
warning, and the first entry is kept. `CLIPROXYAPI_API_KEY`, `CLIPROXYAPI_BASE_URL`,
`CLIPROXYAPI_PROVIDER_ID`, and `CLIPROXYAPI_PROVIDER_NAME` override that field on every entry, same as
on one object. `CLIPROXYAPI_PROVIDER_ID` therefore applies to every entry and can make them conflict.
A single provider keeps `cliproxyapi-models.json` and, for Codex, the WebSocket account id `cpa`. With more than one
provider, the catalog filename and Codex account id use a SHA-256 of the exact `providerId` (fixed ASCII, not
the raw id), because Pi caches Codex sockets by session and account id rather than URL. Anthropic sends no Codex account id. `/cliproxyapi-refresh` refreshes
every provider. `/reload` re-runs each `!command` on its own. Identical command strings still share one
in-process result.

```json
[
  {
    "providerId": "cpa",
    "providerName": "CPA",
    "baseUrl": "https://cpa.example.invalid:27119",
    "apiKey": "$CPA_GATEWAY_KEY"
  },
  {
    "providerId": "tcpa",
    "providerName": "TCPA",
    "api": "anthropic-messages",
    "baseUrl": "https://tcpa.example.invalid:27119",
    "apiKey": "$TCPA_GATEWAY_KEY"
  }
]
```
