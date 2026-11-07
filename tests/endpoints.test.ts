import childProcess from "node:child_process";
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
    expect(readFileSync(join(dir, "cliproxyapi-models.cpa-a.json"), "utf8")).toContain("model-a");
    expect(readFileSync(join(dir, "cliproxyapi-models.cpa-a.json"), "utf8")).not.toContain(
      "model-b",
    );
    expect(readFileSync(join(dir, "cliproxyapi-models.cpa-b.json"), "utf8")).toContain("model-b");
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
      ["cpa-a", "stored-a", "a.example"],
      ["cpa-b", "key-b", "b.example"],
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
        join(dir, `cliproxyapi-models.${id}.json`),
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
      expect(readFileSync(join(dir, "cliproxyapi-models.cpa-a.json"), "utf8")).toContain("model-a"),
    );
    await vi.waitFor(() =>
      expect(readFileSync(join(dir, "cliproxyapi-models.cpa-b.json"), "utf8")).toContain("model-b"),
    );
    expect(readFileSync(home.marker, "utf8")).toBe("x");
    expect(readFileSync(work.marker, "utf8")).toBe("x");
  });

  it("does not register either copy of a duplicate provider id", async () => {
    writeConfig([
      { providerId: "cpa-a", apiKey: "key-a", baseUrl: "https://a.example" },
      { providerId: "cpa-a", apiKey: "key-b", baseUrl: "https://b.example" },
      { providerId: "cpa-b", apiKey: "key-c", baseUrl: "https://c.example" },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await cpaExtension(pi);
    expect(warn.mock.calls).toEqual([
      ['[cliproxyapi] Duplicate provider id "cpa-a"; those endpoints were not registered.'],
    ]);
    expect(runtime.getRegisteredNativeProvider("cpa-a")).toBeUndefined();
    expect(await runtime.getAuth("cpa-a")).toBeUndefined();
    expect((await runtime.getAuth("cpa-b"))?.auth.apiKey).toBe("key-c");
    expect(vi.mocked(globalThis.fetch).mock.calls.map(([url]) => String(url))).toEqual([
      resolveEndpoints("https://c.example").modelsUrl,
    ]);
  });

  it("ignores environment overrides for arrays, including an empty array", async () => {
    process.env.CLIPROXYAPI_API_KEY = "env-key";
    process.env.CLIPROXYAPI_BASE_URL = "https://env.example";
    process.env.CLIPROXYAPI_PROVIDER_ID = "env-id";
    process.env.ENDPOINT_B_KEY = "endpoint-b-key";
    writeConfig([]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await cpaExtension(pi);
    expect(registerCommand).not.toHaveBeenCalled();
    expect(runtime.getRegisteredNativeProvider("env-id")).toBeUndefined();
    expect(runtime.getRegisteredNativeProvider("cpa")).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    warn.mockClear();
    writeConfig([
      { providerId: "cpa-a", apiKey: "key-a", baseUrl: "https://a.example" },
      { providerId: "cpa-b", apiKey: "$ENDPOINT_B_KEY", baseUrl: "https://b.example" },
    ]);
    await cpaExtension(pi);
    expect(warn.mock.calls).toEqual([
      ["[cliproxyapi] CLIPROXYAPI_* environment overrides are ignored for array configs."],
    ]);
    expect((await runtime.getAuth("cpa-a"))?.auth.apiKey).toBe("key-a");
    expect((await runtime.getAuth("cpa-b"))?.auth.apiKey).toBe("endpoint-b-key");
    expect(await runtime.getAuth("env-id")).toBeUndefined();
    const urls = vi.mocked(globalThis.fetch).mock.calls.map(([url]) => String(url));
    expect(urls).toContain(resolveEndpoints("https://a.example").modelsUrl);
    expect(urls).toContain(resolveEndpoints("https://b.example").modelsUrl);
    expect(urls.some((url) => url.includes("env.example"))).toBe(false);
  });

  it("skips one invalid endpoint without dropping its sibling", async () => {
    writeConfig([
      { providerId: "cpa-a", apiKey: "key-a", baseUrl: "http://[" },
      { providerId: "cpa-b", apiKey: "key-b", baseUrl: "https://b.example" },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await cpaExtension(pi);
    expect(warn.mock.calls).toEqual([
      ["[cliproxyapi] Invalid base URL for cpa-a; provider not registered."],
    ]);
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

  it("reloads each command credential without reusing the other endpoint's key", async () => {
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
      { providerId: "cpa-b", apiKey: files[1]!.raw, baseUrl: "https://b.example" },
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
        ["a.example", "cpa-a", "key-a"],
        ["b.example", "cpa-b", "key-b"],
      ]);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "WebSocket", descriptor);
      else delete (globalThis as { WebSocket?: unknown }).WebSocket;
    }
  });

  it("keeps the historical cpa account id for a single object with a custom provider id", async () => {
    writeConfig({
      providerId: "cpa2",
      providerName: "CPA",
      apiKey: "key-a",
      baseUrl: "https://a.example",
    });
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
