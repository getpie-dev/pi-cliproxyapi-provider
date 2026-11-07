import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore, type Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import cpaExtension, { resolveEndpoints } from "../extensions/index.ts";

let dir: string;
let previousEnv: NodeJS.ProcessEnv;
let credentials: InMemoryCredentialStore;
let runtime: ModelRuntime;
let pi: ExtensionAPI;
const registerCommand = vi.fn();
const SSE =
  'data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[],"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}\n\n';

function endpointDigest(providerId: string) {
  return createHash("sha256").update(providerId).digest("hex");
}

function catalogCache(providerId: string) {
  return `cliproxyapi-models.${endpointDigest(providerId)}.json`;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pi-cpa-endpoints-"));
  previousEnv = process.env;
  process.env = { PATH: previousEnv.PATH, HOME: dir, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1" };
  credentials = new InMemoryCredentialStore();
  runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    refreshOnCreate: false,
  });
  registerCommand.mockReset();
  pi = {
    unregisterProvider: (id: string) => runtime.unregisterProvider(id),
    registerProvider: (provider: Parameters<ModelRuntime["registerNativeProvider"]>[0]) =>
      runtime.registerNativeProvider(provider),
    registerCommand,
    on: vi.fn(),
  } as unknown as ExtensionAPI;
  vi.spyOn(childProcess, "execSync").mockImplementation(() => {
    throw new Error("synchronous command execution");
  });
  syncBuiltinESMExports();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const id = String(url).includes("b.example") ? "model-b" : "model-a";
    return new Response(JSON.stringify({ data: [{ id }] }));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  process.env = previousEnv;
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(config: unknown) {
  writeFileSync(join(dir, "cliproxyapi.json"), JSON.stringify(config));
}

function modelFixture(id: string, name = id) {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

async function refreshCatalog() {
  const handler = registerCommand.mock.calls.at(-1)![1].handler;
  const notify = vi.fn();
  await handler("", { ui: { notify } });
  return notify;
}

const ANTHROPIC_SSE = [
  {
    type: "message_start",
    message: {
      id: "msg-test",
      type: "message",
      role: "assistant",
      model: "glm-test",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 0 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "synthetic reply" } },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 3 },
  },
  { type: "message_stop" },
]
  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  .join("");

describe("per-endpoint protocols", () => {
  it("skips an unsupported protocol before resolving credentials, keeping valid siblings", async () => {
    writeConfig([
      {
        providerId: "tcpa",
        api: "secret-unsupported",
        apiKey: "!secret-command",
        baseUrl: "https://secret-host.example",
      },
      {
        providerId: "tcpa",
        api: "anthropic-messages",
        apiKey: "synthetic-key",
        baseUrl: "https://gateway.example",
      },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exec = vi.spyOn(childProcess, "exec");
    syncBuiltinESMExports();
    await cpaExtension(pi);
    expect(warn.mock.calls).toEqual([["[cliproxyapi] Unsupported api; provider not registered."]]);
    expect(exec).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(runtime.getModel("tcpa", "model-a")?.api).toBe("anthropic-messages");
  });

  it.each([
    [false, "https://gateway.example", "https://gateway.example"],
    [true, "https://gateway.example/v1/", "https://gateway.example"],
    [false, "gateway.example/proxy/v1", "http://gateway.example/proxy"],
    [true, undefined, "http://127.0.0.1:8317"],
  ])("streams Anthropic through the gateway (array=%s, base=%s)", async (array, baseUrl, root) => {
    process.env.GATEWAY_KEY = " synthetic-gateway-key ";
    const config = { api: "anthropic-messages", apiKey: "$GATEWAY_KEY", baseUrl };
    writeConfig(array ? [config] : config);
    const requests: { url: string; headers: Headers; body: unknown }[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      const href = String(url);
      const headers = new Headers(init?.headers);
      requests.push({
        url: href,
        headers,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (href === `${root}/v1/models?client_version=pi`) {
        expect(headers.get("authorization")).toBe("Bearer synthetic-gateway-key");
        return new Response(JSON.stringify({ data: [{ id: "glm-test" }] }));
      }
      expect(href).toBe(`${root}/v1/messages?beta=true`);
      return new Response(ANTHROPIC_SSE, { headers: { "content-type": "text/event-stream" } });
    });
    await cpaExtension(pi);
    const model = runtime.getModel("cpa", "glm-test")!;
    expect(model).toMatchObject({ api: "anthropic-messages", baseUrl: root, reasoning: false });
    expect(await runtime.getAvailable("cpa")).toHaveLength(1);
    const context = {
      systemPrompt: "synthetic system",
      messages: [{ role: "user" as const, content: "hello gateway", timestamp: 0 }],
    };
    for (const full of [false, true]) {
      const result = await (full
        ? runtime.stream(model, context)
        : runtime.streamSimple(model, context)
      ).result();
      expect(result.errorMessage).toBeUndefined();
      expect(result.stopReason).toBe("stop");
      expect(result.content).toEqual([{ type: "text", text: "synthetic reply" }]);
      expect(result.usage).toMatchObject({ input: 2, output: 3 });
    }
    expect(requests).toHaveLength(3);
    for (const request of requests.slice(1)) {
      expect(request.headers.get("x-api-key")).toBe("synthetic-gateway-key");
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("chatgpt-account-id")).toBeNull();
      expect(request.headers.get("anthropic-version")).toBe("2023-06-01");
      expect(request.headers.get("content-type")).toBe("application/json");
      expect(request.headers.get("accept")).toBe("application/json");
      expect(request.body).toMatchObject({
        model: "glm-test",
        stream: true,
        messages: [{ role: "user", content: [{ type: "text", text: "hello gateway" }] }],
        system: [{ type: "text", text: "synthetic system" }],
      });
      expect(JSON.stringify(request.body)).not.toContain("cpa_v1.");
    }
  });

  it("isolates mixed-protocol models, credentials, refreshes, and caches", async () => {
    writeConfig([
      { providerId: "cpa", apiKey: "codex-key", baseUrl: "https://cpa.example" },
      {
        providerId: "tcpa",
        api: "anthropic-messages",
        apiKey: "gateway-key",
        baseUrl: "https://tcpa.example/v1",
      },
    ]);
    await credentials.modify("tcpa", async () => ({ type: "api_key", key: "stored-gateway-key" }));
    const inference: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const catalogs: [string, string | null][] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      const href = String(url);
      const headers = new Headers(init?.headers);
      if (href.includes("/v1/models")) {
        catalogs.push([href, headers.get("authorization")]);
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "shared-model",
                supported_reasoning_levels: ["none", "high"],
                context_window: 64000,
                max_output_tokens: 8000,
                input_modalities: ["text", "image"],
              },
            ],
          }),
        );
      }
      inference.push({
        url: href,
        headers,
        body: href.includes("tcpa.example") ? JSON.parse(String(init?.body)) : {},
      });
      return new Response(href.includes("tcpa.example") ? ANTHROPIC_SSE : SSE, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    await cpaExtension(pi);
    const codex = runtime.getModel("cpa", "shared-model")!;
    const anthropic = runtime.getModel("tcpa", "shared-model")!;
    expect(codex).toMatchObject({
      api: "openai-codex-responses",
      thinkingLevelMap: { off: "none", high: "high" },
    });
    expect(anthropic).toMatchObject({
      api: "anthropic-messages",
      provider: "tcpa",
      reasoning: true,
      contextWindow: 64000,
      maxTokens: 8000,
      input: ["text", "image"],
    });
    expect(anthropic.thinkingLevelMap).toBeUndefined();
    expect((await runtime.getAuth("cpa"))?.auth.apiKey).toBe("codex-key");
    expect((await runtime.getAuth("tcpa"))?.auth.apiKey).toBe("stored-gateway-key");
    const context = { messages: [{ role: "user" as const, content: "synthetic", timestamp: 0 }] };
    const codexResult = await runtime
      .streamSimple(codex, context, { transport: "sse", sessionId: "mixed" })
      .result();
    expect(codexResult.errorMessage).toBeUndefined();
    expect(codexResult.stopReason).toBe("stop");
    for (const apiKey of [undefined, "request-gateway-key"]) {
      expect(
        (
          await runtime
            .streamSimple(anthropic, context, { apiKey, sessionId: "mixed", reasoning: "high" })
            .result()
        ).stopReason,
      ).toBe("stop");
    }
    expect(inference.map(({ url }) => url)).toEqual([
      "https://cpa.example/backend-api/codex/responses",
      "https://tcpa.example/v1/messages?beta=true",
      "https://tcpa.example/v1/messages?beta=true",
    ]);
    expect(inference[0]!.headers.get("x-api-key")).toBe("codex-key");
    expect(inference[0]!.headers.get("chatgpt-account-id")).toBe(endpointDigest("cpa"));
    for (const [index, key] of [
      [1, "stored-gateway-key"],
      [2, "request-gateway-key"],
    ] as const) {
      expect(inference[index]!.headers.get("x-api-key")).toBe(key);
      expect(inference[index]!.headers.get("authorization")).toBeNull();
      expect(inference[index]!.headers.get("chatgpt-account-id")).toBeNull();
      expect(inference[index]!.headers.get("content-type")).toBe("application/json");
      expect(inference[index]!.headers.get("accept")).toBe("application/json");
      expect(inference[index]!.body.thinking).toMatchObject({ type: "enabled" });
    }
    expect(await refreshCatalog()).toHaveBeenCalledWith(
      "Refreshed 1 cpa models. Refreshed 1 tcpa models.",
      "info",
    );
    expect(catalogs).toEqual([
      ["https://cpa.example/v1/models?client_version=pi", "Bearer codex-key"],
      ["https://tcpa.example/v1/models?client_version=pi", "Bearer gateway-key"],
      ["https://cpa.example/v1/models?client_version=pi", "Bearer codex-key"],
      ["https://tcpa.example/v1/models?client_version=pi", "Bearer gateway-key"],
    ]);
    for (const [id, api] of [
      ["cpa", "openai-codex-responses"],
      ["tcpa", "anthropic-messages"],
    ]) {
      const cache = JSON.parse(readFileSync(join(dir, catalogCache(id!)), "utf8"));
      expect(cache.api).toBe(api);
      expect(cache.modelsUrl).toContain(`${id}.example`);
      expect(JSON.stringify(cache)).not.toContain("key");
    }
  });

  it.each([
    [undefined, "anthropic-messages"],
    ["openai-codex-responses", "anthropic-messages"],
    ["anthropic-messages", "openai-codex-responses"],
  ])("rejects stale %s metadata when configured as %s", async (cachedApi, api) => {
    writeConfig({ api, apiKey: "synthetic", baseUrl: "https://gateway.example" });
    writeFileSync(
      join(dir, "cliproxyapi-models.json"),
      JSON.stringify({
        modelsUrl: "https://gateway.example/v1/models?client_version=pi",
        api: cachedApi,
        models: [
          { ...modelFixture("stale-model"), thinkingLevelMap: { off: "none", high: "high" } },
        ],
      }),
    );
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("offline"));
    await cpaExtension(pi);
    expect(runtime.getModel("cpa", "stale-model")).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "fresh-model" }] })),
    );
    await refreshCatalog();
    expect(runtime.getModel("cpa", "fresh-model")?.api).toBe(api);
    expect(JSON.parse(readFileSync(join(dir, "cliproxyapi-models.json"), "utf8")).api).toBe(api);
  });

  it("uses a matching Anthropic cache while its background refresh is offline", async () => {
    writeConfig({
      api: "anthropic-messages",
      apiKey: "synthetic",
      baseUrl: "https://gateway.example",
    });
    writeFileSync(
      join(dir, "cliproxyapi-models.json"),
      JSON.stringify({
        modelsUrl: "https://gateway.example/v1/models?client_version=pi",
        api: "anthropic-messages",
        models: [modelFixture("cached-glm")],
      }),
    );
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("offline"));
    await cpaExtension(pi);
    expect(runtime.getModel("cpa", "cached-glm")).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://gateway.example",
    });
  });
});

describe("multiple CLIProxyAPI endpoints", () => {
  it("routes credentials, catalogs, and requests to the selected endpoint", async () => {
    const legacy = `${JSON.stringify({
      modelsUrl: resolveEndpoints("https://a.example").modelsUrl,
      models: [modelFixture("legacy-model")],
    })}\n`;
    writeFileSync(join(dir, "cliproxyapi-models.json"), legacy);
    writeConfig([
      { providerId: "cpa-a", providerName: "Home", apiKey: "key-a", baseUrl: "https://a.example" },
      { providerId: "cpa-b", providerName: "Work", apiKey: "key-b", baseUrl: "https://b.example" },
    ]);
    await credentials.modify("cpa-a", async () => ({ type: "api_key", key: "stored-a" }));
    const seen: {
      url: string;
      authorization: string | null;
      apiKey: string | null;
      account: string | null;
    }[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      const headers = new Headers(init?.headers);
      const href = String(url);
      seen.push({
        url: href,
        authorization: headers.get("authorization"),
        apiKey: headers.get("x-api-key"),
        account: headers.get("chatgpt-account-id"),
      });
      if (href.includes("/v1/models")) {
        const id = href.includes("b.example") ? "model-b" : "model-a";
        return new Response(JSON.stringify({ data: [{ id }] }));
      }
      return new Response(SSE, { headers: { "content-type": "text/event-stream" } });
    });
    await cpaExtension(pi);
    expect(runtime.getRegisteredNativeProvider("cpa-a")?.name).toBe("Home");
    expect(runtime.getRegisteredNativeProvider("cpa-b")?.name).toBe("Work");
    expect(runtime.getModel("cpa-a", "model-b")).toBeUndefined();
    expect(runtime.getModel("cpa-b", "model-a")).toBeUndefined();
    expect(runtime.getModel("cpa-a", "legacy-model")).toBeUndefined();
    expect(runtime.getModel("cpa-a", "model-a")?.baseUrl).toBe("https://a.example/backend-api/");
    expect(runtime.getModel("cpa-b", "model-b")?.baseUrl).toBe("https://b.example/backend-api/");
    expect((await runtime.getAuth("cpa-a"))?.auth.apiKey).toBe("stored-a");
    expect((await runtime.getAuth("cpa-b"))?.auth.apiKey).toBe("key-b");
    expect(readFileSync(join(dir, "cliproxyapi-models.json"), "utf8")).toBe(legacy);
    expect(readFileSync(join(dir, catalogCache("cpa-a")), "utf8")).toContain("model-a");
    expect(readFileSync(join(dir, catalogCache("cpa-a")), "utf8")).not.toContain("model-b");
    expect(readFileSync(join(dir, catalogCache("cpa-b")), "utf8")).toContain("model-b");
    expect(seen.map((call) => [call.url, call.authorization])).toEqual([
      [resolveEndpoints("https://a.example").modelsUrl, "Bearer key-a"],
      [resolveEndpoints("https://b.example").modelsUrl, "Bearer key-b"],
    ]);

    const stream = (providerId: string, modelId: string) =>
      runtime
        .streamSimple(
          runtime.getModel(providerId, modelId)! as Model<"openai-codex-responses">,
          { messages: [] },
          { transport: "sse", sessionId: "shared-session" },
        )
        .result();
    expect((await stream("cpa-a", "model-a")).stopReason).toBe("stop");
    expect((await stream("cpa-b", "model-b")).stopReason).toBe("stop");
    const inference = seen.filter((call) => call.url.includes("/backend-api/"));
    expect(inference.map((call) => [call.account, call.apiKey, new URL(call.url).host])).toEqual([
      [endpointDigest("cpa-a"), "stored-a", "a.example"],
      [endpointDigest("cpa-b"), "key-b", "b.example"],
    ]);
    expect(childProcess.execSync).not.toHaveBeenCalled();
  });

  it("uses each endpoint cache without blocking on its command", async () => {
    const gated = (id: string, key: string) => {
      const script = join(dir, `${id}.cjs`);
      const marker = join(dir, `${id}.runs`);
      const gate = join(dir, `${id}.gate`);
      writeFileSync(
        script,
        `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(marker)}, "x");
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(gate)})) {
    clearInterval(timer);
    process.stdout.write(${JSON.stringify(key)});
  }
}, 10);`,
      );
      return {
        raw: `!exec "${process.execPath}" "${script}"`,
        marker,
        open: () => writeFileSync(gate, ""),
      };
    };
    const home = gated("home", "key-a");
    const work = gated("work", "key-b");
    writeConfig([
      { providerId: "cpa-a", apiKey: home.raw, baseUrl: "https://a.example" },
      { providerId: "cpa-b", apiKey: work.raw, baseUrl: "https://b.example" },
    ]);
    for (const [id, baseUrl, modelId] of [
      ["cpa-a", "https://a.example", "cached-a"],
      ["cpa-b", "https://b.example", "cached-b"],
    ] as const) {
      writeFileSync(
        join(dir, catalogCache(id)),
        JSON.stringify({
          modelsUrl: resolveEndpoints(baseUrl).modelsUrl,
          models: [modelFixture(modelId, `Cached ${modelId}`)],
        }),
      );
    }
    await cpaExtension(pi);
    await vi.waitFor(() => expect(readFileSync(home.marker, "utf8")).toBe("x"));
    await vi.waitFor(() => expect(readFileSync(work.marker, "utf8")).toBe("x"));
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(runtime.getModel("cpa-a", "cached-a")?.baseUrl).toBe("https://a.example/backend-api/");
    expect(runtime.getModel("cpa-b", "cached-b")?.baseUrl).toBe("https://b.example/backend-api/");
    expect(await runtime.getAvailable("cpa-a")).toHaveLength(1);
    expect(await runtime.getAvailable("cpa-b")).toHaveLength(1);
    expect(readFileSync(home.marker, "utf8")).toBe("x");
    home.open();
    work.open();
    expect((await runtime.getAuth("cpa-a"))?.auth.apiKey).toBe("key-a");
    expect((await runtime.getAuth("cpa-b"))?.auth.apiKey).toBe("key-b");
    await vi.waitFor(() =>
      expect(readFileSync(join(dir, catalogCache("cpa-a")), "utf8")).toContain("model-a"),
    );
    await vi.waitFor(() =>
      expect(readFileSync(join(dir, catalogCache("cpa-b")), "utf8")).toContain("model-b"),
    );
    expect(readFileSync(home.marker, "utf8")).toBe("x");
    expect(readFileSync(work.marker, "utf8")).toBe("x");
  });

  it("skips an exact duplicate provider id and keeps the first entry", async () => {
    writeConfig([
      { providerId: "cpa-a", apiKey: "key-a", baseUrl: "https://a.example" },
      { providerId: "cpa-a", apiKey: "key-b", baseUrl: "https://b.example" },
      { providerId: "cpa-b", apiKey: "key-c", baseUrl: "https://c.example" },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await cpaExtension(pi);
    expect(warn.mock.calls).toEqual([
      [
        '[cliproxyapi] Provider id "cpa-a" is configured more than once; the duplicate was skipped.',
      ],
    ]);
    expect((await runtime.getAuth("cpa-a"))?.auth.apiKey).toBe("key-a");
    expect(runtime.getModel("cpa-a", "model-a")?.baseUrl).toBe("https://a.example/backend-api/");
    expect(runtime.getModel("cpa-a", "model-b")).toBeUndefined();
    expect((await runtime.getAuth("cpa-b"))?.auth.apiKey).toBe("key-c");
    expect(vi.mocked(globalThis.fetch).mock.calls.map(([url]) => String(url))).toEqual([
      resolveEndpoints("https://a.example").modelsUrl,
      resolveEndpoints("https://c.example").modelsUrl,
    ]);
  });

  it("applies environment overrides to every array entry", async () => {
    process.env.CLIPROXYAPI_API_KEY = "env-key";
    process.env.CLIPROXYAPI_BASE_URL = "https://env.example";
    process.env.ENDPOINT_B_KEY = "endpoint-b-key";
    writeConfig([]);
    await cpaExtension(pi);
    expect(registerCommand).not.toHaveBeenCalled();
    expect(runtime.getRegisteredNativeProvider("cpa")).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    writeConfig([
      { providerId: "cpa-a", apiKey: "key-a", baseUrl: "https://a.example" },
      { providerId: "cpa-b", apiKey: "$ENDPOINT_B_KEY", baseUrl: "https://b.example" },
    ]);
    await cpaExtension(pi);
    expect((await runtime.getAuth("cpa-a"))?.auth.apiKey).toBe("env-key");
    expect((await runtime.getAuth("cpa-b"))?.auth.apiKey).toBe("env-key");
    const urls = vi.mocked(globalThis.fetch).mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      resolveEndpoints("https://env.example").modelsUrl,
      resolveEndpoints("https://env.example").modelsUrl,
    ]);
    const hosts = vi
      .mocked(globalThis.fetch)
      .mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization"));
    expect(hosts).toEqual(["Bearer env-key", "Bearer env-key"]);
  });

  it("collapses entries onto CLIPROXYAPI_PROVIDER_ID instead of inventing another id", async () => {
    process.env.CLIPROXYAPI_PROVIDER_ID = "env-id";
    writeConfig([
      { providerId: "cpa-a", apiKey: "key-a", baseUrl: "https://a.example" },
      { providerId: "cpa-b", providerName: "Work", apiKey: "key-b", baseUrl: "https://b.example" },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await cpaExtension(pi);
    expect(warn.mock.calls).toEqual([
      [
        '[cliproxyapi] Provider id "env-id" is configured more than once; the duplicate was skipped.',
      ],
    ]);
    expect(runtime.getRegisteredNativeProvider("cpa-a")).toBeUndefined();
    expect(runtime.getRegisteredNativeProvider("cpa-b")).toBeUndefined();
    expect(runtime.getRegisteredNativeProvider("env-id")?.name).toBe("env-id");
    expect((await runtime.getAuth("env-id"))?.auth.apiKey).toBe("key-a");
    expect(runtime.getModel("env-id", "model-a")?.baseUrl).toBe("https://a.example/backend-api/");
  });

  it("skips one invalid endpoint without dropping its sibling", async () => {
    writeConfig([
      { providerId: "cpa-a", apiKey: "key-a", baseUrl: "http://[" },
      { providerId: "cpa-b", apiKey: "key-b", baseUrl: "https://b.example" },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await cpaExtension(pi);
    expect(warn.mock.calls).toEqual([["[cliproxyapi] Invalid base URL; provider not registered."]]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("http://[");
    expect(runtime.getRegisteredNativeProvider("cpa-a")).toBeUndefined();
    expect((await runtime.getAuth("cpa-b"))?.auth.apiKey).toBe("key-b");
  });

  it("refreshes every endpoint and keeps going when one catalog fails", async () => {
    writeConfig([
      { providerId: "cpa-a", providerName: "Home", apiKey: "key-a", baseUrl: "https://a.example" },
      { providerId: "cpa-b", providerName: "Work", apiKey: "key-b", baseUrl: "https://b.example" },
    ]);
    let failB = true;
    const seen: string[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      const href = String(url);
      const authorization = new Headers(init?.headers).get("authorization");
      seen.push(`${href} ${authorization}`);
      if (href.includes("b.example") && failB) return new Response("no", { status: 503 });
      const id = href.includes("b.example") ? "model-b" : "model-a";
      return new Response(JSON.stringify({ data: [{ id }] }));
    });
    await cpaExtension(pi);
    expect(runtime.getModel("cpa-a", "model-a")).toBeDefined();
    expect(runtime.getModel("cpa-b", "model-b")).toBeUndefined();
    expect(await refreshCatalog()).toHaveBeenCalledWith(
      "Refreshed 1 Home models. Refresh failed for Work: models HTTP 503",
      "error",
    );
    failB = false;
    expect(await refreshCatalog()).toHaveBeenCalledWith(
      "Refreshed 1 Home models. Refreshed 1 Work models.",
      "info",
    );
    expect(runtime.getModel("cpa-b", "model-b")?.baseUrl).toBe("https://b.example/backend-api/");
    expect(seen.some((line) => line.includes("b.example") && line.includes("key-a"))).toBe(false);
    expect(seen.some((line) => line.includes("a.example") && line.includes("key-b"))).toBe(false);
    expect(seen.some((line) => line.includes("b.example") && line.includes("Bearer key-b"))).toBe(
      true,
    );
  });

  it.each([
    "openai-codex-responses",
    "anthropic-messages",
  ])("reloads isolated command credentials with %s", async (api) => {
    const files = ["a", "b"].map((id) => {
      const value = join(dir, `value-${id}`);
      const script = join(dir, `${id}.cjs`);
      const marker = join(dir, `${id}.runs`);
      writeFileSync(value, `old-${id}`);
      writeFileSync(
        script,
        `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x");
process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(value)}, "utf8"));`,
      );
      return {
        id,
        value,
        marker,
        raw: `!exec "${process.execPath}" "${script}"`,
      };
    });
    writeConfig([
      { providerId: "cpa-a", apiKey: files[0]!.raw, baseUrl: "https://a.example" },
      { providerId: "cpa-b", api, apiKey: files[1]!.raw, baseUrl: "https://b.example" },
    ]);
    await cpaExtension(pi);
    expect((await runtime.getAuth("cpa-a"))?.auth.apiKey).toBe("old-a");
    expect((await runtime.getAuth("cpa-b"))?.auth.apiKey).toBe("old-b");
    const load = async (reason: string) => {
      await cpaExtension(pi);
      const calls = vi.mocked(pi.on).mock.calls as unknown as [
        string,
        (event: unknown) => unknown,
      ][];
      const handler = calls.filter(([event]) => event === "session_start").at(-1)![1];
      await handler({ type: "session_start", reason });
    };
    writeFileSync(files[0]!.value, "new-a");
    writeFileSync(files[1]!.value, "new-b");
    await load("new");
    expect((await runtime.getAuth("cpa-a"))?.auth.apiKey).toBe("old-a");
    expect((await runtime.getAuth("cpa-b"))?.auth.apiKey).toBe("old-b");
    expect(readFileSync(files[0]!.marker, "utf8")).toBe("x");
    await load("reload");
    expect((await runtime.getAuth("cpa-a"))?.auth.apiKey).toBe("new-a");
    expect((await runtime.getAuth("cpa-b"))?.auth.apiKey).toBe("new-b");
    expect(readFileSync(files[0]!.marker, "utf8")).toBe("xx");
    expect(readFileSync(files[1]!.marker, "utf8")).toBe("xx");
  });

  it("stamps each provider id on the WebSocket handshake for one shared session", async () => {
    writeConfig([
      { providerId: "cpa-a", apiKey: "key-a", baseUrl: "https://a.example" },
      { providerId: "cpa-b", apiKey: "key-b", baseUrl: "https://b.example" },
    ]);
    await cpaExtension(pi);
    const sockets: { url: string; headers: Headers }[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    const completed = JSON.stringify({
      type: "response.completed",
      response: {
        id: "r",
        status: "completed",
        output: [],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
    });
    // Stays open with no readyState so Pi treats it as reusable. A shared account id would
    // reuse the first socket for this session instead of opening a second one.
    class FakeWebSocket extends EventTarget {
      constructor(url: string, init: { headers: Record<string, string> }) {
        super();
        sockets.push({ url, headers: new Headers(init.headers) });
        setTimeout(() => this.dispatchEvent(new Event("open")));
      }
      send() {
        setTimeout(() => {
          const message = new Event("message");
          Object.defineProperty(message, "data", { value: completed });
          this.dispatchEvent(message);
        });
      }
      close() {}
    }
    Object.defineProperty(globalThis, "WebSocket", {
      value: FakeWebSocket,
      writable: false,
      configurable: true,
    });
    try {
      vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
        if (String(url).includes("/v1/models")) {
          return new Response(JSON.stringify({ data: [{ id: "model-a" }] }));
        }
        return new Response(SSE, { headers: { "content-type": "text/event-stream" } });
      });
      for (const [id, modelId] of [
        ["cpa-a", "model-a"],
        ["cpa-b", "model-b"],
      ] as const) {
        const result = await runtime
          .streamSimple(
            runtime.getModel(id, modelId)! as Model<"openai-codex-responses">,
            { messages: [] },
            { transport: "websocket", sessionId: "shared-session" },
          )
          .result();
        expect(result.stopReason).toBe("stop");
      }
      expect(
        sockets.map((socket) => [
          new URL(socket.url).host,
          socket.headers.get("chatgpt-account-id"),
          socket.headers.get("x-api-key"),
        ]),
      ).toEqual([
        ["a.example", endpointDigest("cpa-a"), "key-a"],
        ["b.example", endpointDigest("cpa-b"), "key-b"],
      ]);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "WebSocket", descriptor);
      else delete (globalThis as { WebSocket?: unknown }).WebSocket;
    }
  });

  it("derives distinct fixed identities for unusual and long provider ids", async () => {
    const ids = ["a\nb", "a\rb", "hôme", `L${"x".repeat(400)}`];
    writeConfig(
      ids.map((providerId, index) => ({
        providerId,
        apiKey: `key-${index}`,
        baseUrl: `https://u${index}.example`,
      })),
    );
    const seen: { account: string | null; apiKey: string | null }[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      const href = String(url);
      const headers = new Headers(init?.headers);
      if (href.includes("/v1/models")) {
        const index = new URL(href).host.match(/^u(\d+)/)?.[1] ?? "0";
        return new Response(JSON.stringify({ data: [{ id: `model-${index}` }] }));
      }
      seen.push({
        account: headers.get("chatgpt-account-id"),
        apiKey: headers.get("x-api-key"),
      });
      return new Response(SSE, { headers: { "content-type": "text/event-stream" } });
    });
    await cpaExtension(pi);
    for (const [index, id] of ids.entries()) {
      const digest = endpointDigest(id);
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      expect(catalogCache(id)).toBe(`cliproxyapi-models.${digest}.json`);
      expect(catalogCache(id).includes(id)).toBe(false);
      expect(readFileSync(join(dir, catalogCache(id)), "utf8")).toContain(`model-${index}`);
      const result = await runtime
        .streamSimple(
          runtime.getModel(id, `model-${index}`)! as Model<"openai-codex-responses">,
          { messages: [] },
          { transport: "sse", sessionId: "shared-session" },
        )
        .result();
      expect(result.stopReason).toBe("stop");
      expect((await runtime.getAuth(id))?.auth.apiKey).toBe(`key-${index}`);
    }
    expect(seen.map((call) => call.account)).toEqual(ids.map(endpointDigest));
    expect(new Set(seen.map((call) => call.account)).size).toBe(ids.length);
    expect(seen.map((call) => call.apiKey)).toEqual(ids.map((_, index) => `key-${index}`));
    expect(seen.some((call) => /[\r\n]/.test(call.account ?? ""))).toBe(false);
  });

  it("keeps the historical cpa account id and catalog file for one array entry", async () => {
    writeConfig([
      {
        providerId: "cpa2",
        providerName: "CPA",
        apiKey: "key-a",
        baseUrl: "https://a.example",
      },
    ]);
    const seen: Headers[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      if (String(url).includes("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "model-a" }] }));
      }
      seen.push(new Headers(init?.headers));
      return new Response(SSE, { headers: { "content-type": "text/event-stream" } });
    });
    await cpaExtension(pi);
    expect(readFileSync(join(dir, "cliproxyapi-models.json"), "utf8")).toContain("model-a");
    expect(runtime.getModel("cpa2", "model-a")).toBeDefined();
    const result = await runtime
      .streamSimple(
        runtime.getModel("cpa2", "model-a")! as Model<"openai-codex-responses">,
        { messages: [] },
        { transport: "sse", sessionId: "shared-session" },
      )
      .result();
    expect(result.stopReason).toBe("stop");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.get("chatgpt-account-id")).toBe("cpa");
    expect(seen[0]!.get("x-api-key")).toBe("key-a");
  });
});
