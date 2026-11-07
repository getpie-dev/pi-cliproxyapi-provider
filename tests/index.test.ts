import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  fetchModels,
  loadEndpoints,
  resolveEndpoints,
  resolveKey,
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

  it("wraps API keys in a JWT-shaped token carrying the account id", () => {
    const parts = wrapKey("+UqaZ55q4CGI0P2+6nQj6Zfdb3pj1NGk").split(".");
    expect(parts).toHaveLength(3);
    expect(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"))).toEqual({
      "https://api.openai.com/auth": { chatgpt_account_id: "cpa" },
    });
    expect(wrapKey("k", "cpa-work").split(".")[1]).not.toBe(parts[1]);
    const custom = wrapKey("k", "cpa-work").split(".");
    expect(JSON.parse(Buffer.from(custom[1]!, "base64url").toString("utf8"))).toEqual({
      "https://api.openai.com/auth": { chatgpt_account_id: "cpa-work" },
    });
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
});

describe("endpoint configuration", () => {
  it("uses the same defaults, coercion, and env overrides for an object and [object]", () => {
    const cases: Array<{ config: Record<string, unknown> | null; env: NodeJS.ProcessEnv }> = [
      { config: { apiKey: "file-key" }, env: {} },
      { config: { apiKey: 123, providerId: "  ", providerName: "", baseUrl: "" }, env: {} },
      {
        config: {
          apiKey: "file-key",
          baseUrl: "https://file.example",
          providerId: "file-id",
          providerName: "File",
        },
        env: {
          CLIPROXYAPI_API_KEY: " env-key ",
          CLIPROXYAPI_BASE_URL: " ",
          CLIPROXYAPI_PROVIDER_ID: "env-id",
          CLIPROXYAPI_PROVIDER_NAME: " Env ",
        },
      },
      {
        config: null,
        env: { CLIPROXYAPI_API_KEY: "env-key", CLIPROXYAPI_BASE_URL: "https://env.example" },
      },
    ];
    for (const { config, env } of cases) {
      expect(loadEndpoints([config], env)).toEqual(loadEndpoints(config, env));
    }
    expect(loadEndpoints({ apiKey: "k" }, {}).endpoints).toEqual([
      { providerId: "cpa", providerName: "cpa", rawKey: "k", baseUrl: undefined },
    ]);
    expect(loadEndpoints([{ apiKey: 123 }], {}).endpoints[0]?.rawKey).toBe("123");
    expect(loadEndpoints([], { CLIPROXYAPI_API_KEY: "env-key" })).toEqual({
      endpoints: [],
      warnings: [],
    });
  });

  it("applies the same env overrides to every array entry", () => {
    const env = {
      CLIPROXYAPI_API_KEY: "env-key",
      CLIPROXYAPI_BASE_URL: "https://env.example",
      CLIPROXYAPI_PROVIDER_NAME: "Shared",
    };
    expect(
      loadEndpoints(
        [
          { providerId: " cpa-home ", apiKey: "$HOME_KEY", baseUrl: "https://home.example" },
          { providerId: "cpa-work", apiKey: "work-key" },
        ],
        env,
      ),
    ).toEqual({
      warnings: [],
      endpoints: [
        {
          providerId: "cpa-home",
          providerName: "Shared",
          rawKey: "env-key",
          baseUrl: "https://env.example",
        },
        {
          providerId: "cpa-work",
          providerName: "Shared",
          rawKey: "env-key",
          baseUrl: "https://env.example",
        },
      ],
    });
  });

  it("skips an exact duplicate id and keeps the first, including when env forces one id", () => {
    const skipped = (id: string) =>
      `[cliproxyapi] Provider id ${JSON.stringify(id)} is configured more than once; the duplicate was skipped.`;
    expect(
      loadEndpoints(
        [
          { apiKey: "first", baseUrl: "https://a.example" },
          {
            providerId: "cpa",
            apiKey: "second",
            baseUrl: "https://b.example",
            providerName: "Later",
          },
          { providerId: "CPA", apiKey: "other" },
        ],
        { CLIPROXYAPI_PROVIDER_ID: "" },
      ),
    ).toEqual({
      warnings: [skipped("cpa")],
      endpoints: [
        { providerId: "cpa", providerName: "cpa", rawKey: "first", baseUrl: "https://a.example" },
        { providerId: "CPA", providerName: "CPA", rawKey: "other", baseUrl: undefined },
      ],
    });
    expect(
      loadEndpoints(
        [
          { providerId: "cpa-a", apiKey: "first", baseUrl: "https://a.example" },
          { providerId: "cpa-b", apiKey: "second", baseUrl: "https://b.example" },
        ],
        { CLIPROXYAPI_PROVIDER_ID: "env-id" },
      ),
    ).toEqual({
      warnings: [skipped("env-id")],
      endpoints: [
        {
          providerId: "env-id",
          providerName: "env-id",
          rawKey: "first",
          baseUrl: "https://a.example",
        },
      ],
    });
  });
});
