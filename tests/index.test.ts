import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  ensureWsPatch,
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

  it("preserves literal and environment API keys", async () => {
    vi.stubEnv("TEST_CPA_KEY", " env-key-value ");
    try {
      expect(await resolveKey(" plain-key ")).toBe("plain-key");
      expect(await resolveKey("$TEST_CPA_KEY")).toBe("env-key-value");
      expect(await resolveKey(["$", "{TEST_CPA_KEY}"].join(""))).toBe("env-key-value");
      expect(await resolveKey(undefined)).toBeUndefined();
      expect(await resolveKey("  ")).toBeUndefined();
      expect(await resolveKey("$UNSET_CPA_TEST_KEY")).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
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
              { id: "unlisted", visibility: "none" },
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
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: null,
          medium: null,
          high: "high",
          xhigh: null,
        },
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 500_000,
        maxTokens: 128_000,
      },
    ]);
  });
  it("maps server reasoning levels to Pi thinking levels", async () => {
    const [model] = await fetchModels(
      "https://cpa.example.invalid/v1/models",
      "k",
      (async () =>
        new Response(
          JSON.stringify([
            { id: "m", supported_reasoning_levels: ["none", "low", "medium", "high", "xhigh"] },
          ]),
        )) as typeof fetch,
    );
    expect((model as Model<"openai-codex-responses">).thinkingLevelMap).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    });
    expect(getSupportedThinkingLevels(model as unknown as Model<"openai-codex-responses">)).toEqual(
      ["off", "low", "medium", "high", "xhigh"],
    );
  });
  it("aborts model discovery after ten seconds", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    try {
      const hang = ((_url, init) =>
        new Promise((_resolve, reject) => {
          if (init?.signal?.aborted) reject(init.signal.reason);
        })) as typeof fetch;
      await expect(
        fetchModels("https://cpa.example.invalid/v1/models", "k", hang),
      ).rejects.toThrow();
      expect(timeout).toHaveBeenCalledWith(10_000);
    } finally {
      timeout.mockRestore();
    }
  }, 1_000);
  it("rewrites only WebSockets carrying a wrapped key, including tuple headers, to a plain object", () => {
    const original = globalThis.WebSocket;
    const calls: unknown[][] = [];
    globalThis.WebSocket = class {
      constructor(...args: unknown[]) {
        calls.push(args);
      }
    } as unknown as typeof WebSocket;
    try {
      ensureWsPatch();
      const unrelated = { headers: [["x-other", "1"]] };
      new globalThis.WebSocket("ws://a", unrelated as never);
      expect(calls[0]![1]).toBe(unrelated);
      const headers = [
        ["Authorization", `Bearer ${wrapKey("real-key")}`],
        ["chatgpt-account-id", "cpa"],
      ];
      new globalThis.WebSocket("ws://b", { headers } as never);
      expect(calls[1]![1]).toEqual({ headers: { authorization: "Bearer real-key" } });
    } finally {
      globalThis.WebSocket = original;
    }
  });
  it("reports a read-only WebSocket global (bun compile) instead of throwing", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    const ReadOnly = class {} as unknown as typeof WebSocket;
    Object.defineProperty(globalThis, "WebSocket", {
      value: ReadOnly,
      writable: false,
      configurable: true,
    });
    try {
      // Every request asks again; a failed attempt must not mark the native class as patched.
      expect(ensureWsPatch()).toBe(false);
      expect(ensureWsPatch()).toBe(false);
      expect(globalThis.WebSocket).toBe(ReadOnly);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "WebSocket", descriptor);
      else delete (globalThis as { WebSocket?: unknown }).WebSocket;
    }
  });
});
