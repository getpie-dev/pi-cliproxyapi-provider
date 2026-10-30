import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import cpaExtension, {
  fetchModels,
  patchHeaders,
  resolveEndpoints,
  resolveKey,
  unwrapAuth,
  wrapKey,
} from "../extensions/index.ts";

describe("@getpie/pi-cliproxyapi-provider", () => {
  it("normalizes endpoints for host:port, /v1, and /backend-api", () => {
    expect(resolveEndpoints("https://vps.example.com:27119")).toEqual({
      inferenceBaseUrl: "https://vps.example.com:27119/backend-api/",
      modelsUrl: "https://vps.example.com:27119/v1/models?client_version=pi",
    });
    expect(resolveEndpoints("https://vps.example.com:27119/v1")).toEqual({
      inferenceBaseUrl: "https://vps.example.com:27119/backend-api/",
      modelsUrl: "https://vps.example.com:27119/v1/models?client_version=pi",
    });
  });

  it("resolves literal, env, and !command API keys", () => {
    expect(resolveKey(" plain-key ")).toBe("plain-key");

    process.env.TEST_CPA_KEY = "env-key-value";
    expect(resolveKey("$TEST_CPA_KEY")).toBe("env-key-value");
    expect(resolveKey(["$", "{TEST_CPA_KEY}"].join(""))).toBe("env-key-value");
    delete process.env.TEST_CPA_KEY;

    const resolved = resolveKey(`!"${process.execPath}" -e "process.stdout.write('cmd-key-123')"`);
    expect(resolved).toBe("cmd-key-123");
  });

  it("wraps plain API keys for official Codex stream and unwraps outgoing headers", () => {
    const rawKey = "+UqaZ55q4CGI0P2+6nQj6Zfdb3pj1NGk";
    const wrapped = wrapKey(rawKey);
    expect(wrapped.split(".")).toHaveLength(3);
    expect(unwrapAuth(`Bearer ${wrapped}`)).toBe(`Bearer ${rawKey}`);

    const headers = new Headers({
      Authorization: `Bearer ${wrapped}`,
      "chatgpt-account-id": "cpa",
    });
    patchHeaders(headers);
    expect(headers.get("authorization")).toBe(`Bearer ${rawKey}`);
    expect(headers.get("chatgpt-account-id")).toBeNull();
  });

  it("fetches and maps remote catalog entries", async () => {
    const models = await fetchModels(
      "https://vps.example.com/v1/models?client_version=pi",
      "secret-key",
      (async (_url, init) => {
        const hdrs = init?.headers as Record<string, string> | undefined;
        expect(hdrs?.Authorization).toBe("Bearer secret-key");
        return new Response(
          JSON.stringify({
            data: [
              { id: "hidden", visibility: "hide" },
              {
                slug: "gpt-6.1-sol",
                display_name: "GPT 6.1 Sol",
                context_window: 500_000,
                max_output_tokens: 128_000,
                input_modalities: ["text", "image"],
                supported_reasoning_levels: [{ effort: "high" }],
              },
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    );
    expect(models).toEqual([
      {
        id: "gpt-6.1-sol",
        name: "GPT 6.1 Sol",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 500_000,
        maxTokens: 128_000,
      },
    ]);
  });

  it("loads remote models on startup and registers provider with !command apiKey", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-cpa-test-"));
    const prevDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    const cmd = `!"${process.execPath}" -e "process.stdout.write('op-secret-key')"`;
    writeFileSync(
      join(dir, "cliproxyapi.json"),
      JSON.stringify({
        baseUrl: "https://vps.example.com:27119",
        apiKey: cmd,
        providerId: "cpa",
      }),
    );

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "gpt-6.1-sol" }] }), { status: 200 }),
      );
    const registerProvider = vi.fn();
    const pi = {
      unregisterProvider: vi.fn(),
      registerProvider,
      registerCommand: vi.fn(),
      on: vi.fn(),
    } as unknown as Parameters<typeof cpaExtension>[0];

    try {
      await cpaExtension(pi);
      expect(registerProvider).toHaveBeenCalledWith(
        "cpa",
        expect.objectContaining({
          apiKey: cmd,
          models: [expect.objectContaining({ id: "gpt-6.1-sol" })],
        }),
      );
    } finally {
      fetchMock.mockRestore();
      if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
