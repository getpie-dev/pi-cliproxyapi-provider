import { describe, expect, it, vi } from "vitest";
import {
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
});
