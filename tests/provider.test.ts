import childProcess from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { InMemoryCredentialStore, InMemoryModelsStore, type Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import cpaExtension, { resolveEndpoints, resolveKey } from "../extensions/index.ts";

let dir: string;
let previousEnv: NodeJS.ProcessEnv;
let credentials: InMemoryCredentialStore;
let runtime: ModelRuntime;
let pi: ExtensionAPI;
const registerCommand = vi.fn();
const baseUrl = "https://cpa.example.invalid";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pi-cpa-provider-"));
  previousEnv = process.env;
  // Keep real credentials, home directories, and secret managers out of integration tests.
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
  // Fail if Pi's legacy config parser is reached, including its external ESM imports.
  vi.spyOn(childProcess, "execSync").mockImplementation(() => {
    throw new Error("synchronous command execution");
  });
  syncBuiltinESMExports();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-key");
    return new Response(JSON.stringify({ data: [{ id: "test-model" }] }));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  process.env = previousEnv;
  rmSync(dir, { recursive: true, force: true });
});

function configure(apiKey: string, cached = true) {
  writeFileSync(join(dir, "cliproxyapi.json"), JSON.stringify({ apiKey, baseUrl }));
  if (cached) {
    writeFileSync(
      join(dir, "cliproxyapi-models.json"),
      JSON.stringify({
        modelsUrl: resolveEndpoints(baseUrl).modelsUrl,
        models: [
          {
            id: "test-model",
            name: "Test",
            reasoning: false,
            input: ["text"],
            contextWindow: 128000,
            maxTokens: 1000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      }),
    );
  }
}

function slowCommand() {
  const script = join(dir, "key.cjs");
  const marker = join(dir, "runs");
  writeFileSync(
    script,
    `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x");
    setTimeout(() => process.stdout.write("synthetic-key"), 350);`,
  );
  return { raw: `!exec "${process.execPath}" "${script}"`, marker };
}

async function configureConflictingModelsKey() {
  const modelsPath = join(dir, "models.json");
  writeFileSync(modelsPath, JSON.stringify({ providers: { cpa: { apiKey: "models-key" } } }));
  runtime = await ModelRuntime.create({
    credentials,
    modelsPath,
    modelsStore: new InMemoryModelsStore(),
    refreshOnCreate: false,
  });
}

async function refreshCatalog() {
  const handler = registerCommand.mock.calls[0]![1].handler;
  const notify = vi.fn();
  await handler("", { ui: { notify } });
  return notify;
}

describe("native Pi authentication integration (locked Pi 1.3.0)", () => {
  it("confirms the legacy registration keeps extension credentials above models.json", async () => {
    await configureConflictingModelsKey();
    runtime.registerProvider("cpa", { apiKey: "extension-key" });
    expect((await runtime.getAuth("cpa"))?.auth.apiKey).toBe("extension-key");
  });

  it.each([
    "file",
    "environment",
  ])("keeps %s extension credentials below explicit, runtime, stored, and models.json credentials", async (source) => {
    const { raw, marker } = slowCommand();
    configure(source === "file" ? raw : "config-key");
    if (source === "environment") process.env.CLIPROXYAPI_API_KEY = raw;
    await configureConflictingModelsKey();
    await credentials.modify("cpa", async () => ({ type: "api_key", key: "stored-key" }));
    await cpaExtension(pi);
    expect((await runtime.getAuth("cpa"))?.auth.apiKey).toBe("stored-key");
    await runtime.setRuntimeApiKey("cpa", "runtime-key");
    expect((await runtime.getAuth("cpa"))?.auth.apiKey).toBe("runtime-key");
    expect((await runtime.getAuth("cpa", { apiKey: "request-key" }))?.auth.apiKey).toBe(
      "request-key",
    );
    await runtime.removeRuntimeApiKey("cpa");
    expect((await runtime.getAuth("cpa"))?.auth.apiKey).toBe("stored-key");
    await credentials.delete("cpa");
    expect((await runtime.getAuth("cpa"))?.auth.apiKey).toBe("models-key");
    // Only the background startup prewarm runs the command; auth resolution never does.
    await vi.waitFor(() => expect(readFileSync(marker, "utf8")).toBe("x"));
    expect(childProcess.execSync).not.toHaveBeenCalled();
  });

  it("confirms native and legacy registrations replace rather than compose with one another", async () => {
    const { raw } = slowCommand();
    configure(raw);
    await configureConflictingModelsKey();
    await cpaExtension(pi);
    const native = runtime.getRegisteredNativeProvider("cpa")!;
    runtime.registerProvider("cpa", { apiKey: "legacy-key" });
    expect(runtime.getRegisteredNativeProvider("cpa")).toBeUndefined();
    expect((await runtime.getAuth("cpa"))?.auth.apiKey).toBe("legacy-key");
    runtime.registerNativeProvider(native);
    expect(runtime.getRegisteredProviderConfig("cpa")).toBeUndefined();
    expect((await runtime.getAuth("cpa"))?.auth.apiKey).toBe("models-key");
  });

  it("prewarms a command key at cached startup without awaiting it, then reuses it for auth", async () => {
    const { raw, marker } = slowCommand();
    configure(raw);
    const started = Date.now();
    await cpaExtension(pi);
    // The command sleeps 350ms; startup must not wait for it.
    expect(Date.now() - started).toBeLessThan(300);
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect((await runtime.getAuth("cpa"))?.auth.apiKey).toBe("synthetic-key");
    expect(readFileSync(marker, "utf8")).toBe("x");
    expect(childProcess.execSync).not.toHaveBeenCalled();
  });

  it("keeps cached startup and model availability non-blocking, then authenticates asynchronously", async () => {
    const { raw, marker } = slowCommand();
    configure(raw);
    await cpaExtension(pi);
    await runtime.refresh({ allowNetwork: false });
    expect(runtime.getModel("cpa", "test-model")).toBeDefined();
    expect(await runtime.getAvailable("cpa")).toHaveLength(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(runtime.getRegisteredProviderConfig("cpa")).toBeUndefined();

    let settled = false;
    const auth = runtime.getAuth("cpa").then((result) => {
      settled = true;
      return result;
    });
    const refresh = refreshCatalog();
    await delay(25);
    expect(settled).toBe(false);
    expect((await auth)?.auth.apiKey).toBe("synthetic-key");
    expect(await refresh).toHaveBeenCalledWith("Refreshed 1 cpa models.", "info");
    expect((await runtime.getAuth("cpa"))?.auth.apiKey).toBe("synthetic-key");
    expect(readFileSync(marker, "utf8")).toBe("x");
    expect(childProcess.execSync).not.toHaveBeenCalled();
  });

  it("uses the same asynchronous cached credential for cold discovery and request authentication", async () => {
    const { raw, marker } = slowCommand();
    configure(raw, false);
    let settled = false;
    const startup = cpaExtension(pi).then(() => {
      settled = true;
    });
    await delay(25);
    expect(settled).toBe(false);
    await startup;
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(readFileSync(join(dir, "cliproxyapi-models.json"), "utf8")).toContain("test-model");
    expect((await runtime.getAuth("cpa"))?.auth.apiKey).toBe("synthetic-key");
    expect(readFileSync(marker, "utf8")).toBe("x");
    expect(childProcess.execSync).not.toHaveBeenCalled();
  });

  it("never falls back to raw commands after failure or empty output, and retries safely", async () => {
    const script = join(dir, "retry.cjs");
    const value = join(dir, "value");
    writeFileSync(
      script,
      `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(value)}, "utf8"))`,
    );
    configure(`!exec "${process.execPath}" "${script}"`);
    await cpaExtension(pi);
    await expect(runtime.getAuth("cpa")).rejects.toMatchObject({
      cause: { message: "API key command failed" },
    });
    const notify = await refreshCatalog();
    expect(notify).toHaveBeenCalledWith("Refresh failed: API key command failed", "error");
    writeFileSync(value, "  ");
    expect(await runtime.getAuth("cpa")).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    writeFileSync(value, "synthetic-key");
    expect((await runtime.getAuth("cpa"))?.auth.apiKey).toBe("synthetic-key");
    expect(childProcess.execSync).not.toHaveBeenCalled();
  });

  it("preserves stored/runtime keys over extension env/config", async () => {
    const { raw, marker } = slowCommand();
    configure("config-key");
    process.env.CLIPROXYAPI_API_KEY = raw;
    await credentials.modify("cpa", async () => ({ type: "api_key", key: "stored-key" }));
    await cpaExtension(pi);
    expect((await runtime.getAuth("cpa"))?.auth.apiKey).toBe("stored-key");
    await runtime.setRuntimeApiKey("cpa", "runtime-key");
    expect((await runtime.getAuth("cpa"))?.auth.apiKey).toBe("runtime-key");
    expect((await runtime.getAuth("cpa", { apiKey: "request-key" }))?.auth.apiKey).toBe(
      "request-key",
    );
    await runtime.removeRuntimeApiKey("cpa");
    await credentials.delete("cpa");
    expect((await runtime.getAuth("cpa"))?.auth.apiKey).toBe("synthetic-key");
    expect(readFileSync(marker, "utf8")).toBe("x");
  });

  it.each([
    "literal",
    "environment",
  ])("preserves %s credentials and cached-catalog background refresh", async (kind) => {
    process.env.TEST_CPA_KEY = " synthetic-key ";
    configure(kind === "literal" ? "synthetic-key" : "$TEST_CPA_KEY");
    await cpaExtension(pi);
    expect((await runtime.getAuth("cpa"))?.auth.apiKey).toBe("synthetic-key");
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
  });

  it.each([
    ["empty", "", true],
    ["invalid", "http://[", false],
  ])("falls back for an %s base URL instead of crashing startup", async (_kind, url, registered) => {
    writeFileSync(join(dir, "cliproxyapi.json"), JSON.stringify({ apiKey: "synthetic-key", baseUrl: url }));
    process.env.CLIPROXYAPI_BASE_URL = url;
    await expect(cpaExtension(pi)).resolves.toBeUndefined();
    expect(registerCommand).toHaveBeenCalledTimes(registered ? 1 : 0);
  });

  it("leaves session resource cleanup to Pi instead of closing every Codex WebSocket", async () => {
    configure("synthetic-key");
    await cpaExtension(pi);
    const events = vi.mocked(pi.on).mock.calls.map(([event]) => event);
    expect(events).not.toContain("session_compact");
    expect(events).not.toContain("session_shutdown");
  });

  it("keeps Codex wrapping and sends only the real Bearer key through the actual request pipeline", async () => {
    const { raw, marker } = slowCommand();
    configure(raw);
    await cpaExtension(pi);
    const fetchMock = vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer synthetic-key");
      expect(headers.get("chatgpt-account-id")).toBeNull();
      return new Response(
        'data: {"type":"response.completed","response":{"id":"test-response","status":"completed","output":[],"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}\n\n',
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    });
    const model = runtime.getModel("cpa", "test-model")! as Model<"openai-codex-responses">;
    const pending = runtime.streamSimple(model, { messages: [] }, { transport: "sse" }).result();
    await delay(25);
    expect(fetchMock).not.toHaveBeenCalled();
    const result = await pending;
    expect(result.errorMessage).toBeUndefined();
    expect(result.stopReason).toBe("stop");
    expect(fetchMock).toHaveBeenCalledOnce();
    // The explicit full-stream path uses the same wrapper as the legacy provider did.
    expect(
      (await runtime.stream(model, { messages: [] }, { transport: "sse" }).result()).stopReason,
    ).toBe("stop");
    expect(await resolveKey(raw)).toBe("synthetic-key");
    expect(readFileSync(marker, "utf8")).toBe("x");
    expect(childProcess.execSync).not.toHaveBeenCalled();
  });
});
