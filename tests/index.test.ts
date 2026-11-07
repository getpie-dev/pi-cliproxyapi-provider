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
  const ignored =
    "[cliproxyapi] CLIPROXYAPI_* environment overrides are ignored for array configs.";

  it("preserves single-object overrides, empty env values, and the cpa account id", () => {
    expect(
      loadEndpoints(
        {
          apiKey: "file-key",
          baseUrl: "https://file.example",
          providerId: "file-id",
          providerName: "File",
        },
        {
          CLIPROXYAPI_API_KEY: " env-key ",
          CLIPROXYAPI_BASE_URL: " ",
          CLIPROXYAPI_PROVIDER_ID: "env-id",
        },
      ),
    ).toEqual({
      warnings: [],
      endpoints: [
        {
          providerId: "env-id",
          providerName: "File",
          accountId: "cpa",
          rawKey: "env-key",
          baseUrl: "https://file.example",
          cacheFile: "cliproxyapi-models.json",
        },
      ],
    });
    expect(loadEndpoints({ apiKey: 123, providerId: "cpa2" }, {}).endpoints[0]).toMatchObject({
      providerId: "cpa2",
      providerName: "cpa2",
      accountId: "cpa",
      rawKey: "123",
      cacheFile: "cliproxyapi-models.json",
    });
    expect(loadEndpoints(null, {})).toEqual({ endpoints: [], warnings: [] });
  });

  it("keeps array entries isolated and does not apply environment overrides", () => {
    const env = {
      CLIPROXYAPI_API_KEY: "env-key",
      CLIPROXYAPI_BASE_URL: "https://env.example",
      CLIPROXYAPI_PROVIDER_ID: "env-id",
      CLIPROXYAPI_PROVIDER_NAME: "Env",
    };
    expect(
      loadEndpoints(
        [
          {
            providerId: " cpa-home ",
            providerName: " Home ",
            baseUrl: " https://home.example ",
            apiKey: " $WORK_CPA_KEY ",
          },
          { providerId: "cpa-work", apiKey: "work-key" },
        ],
        env,
      ),
    ).toEqual({
      warnings: [ignored],
      endpoints: [
        {
          providerId: "cpa-home",
          providerName: "Home",
          accountId: "cpa-home",
          rawKey: "$WORK_CPA_KEY",
          baseUrl: "https://home.example",
          cacheFile: "cliproxyapi-models.cpa-home.json",
        },
        {
          providerId: "cpa-work",
          providerName: "cpa-work",
          accountId: "cpa-work",
          rawKey: "work-key",
          cacheFile: "cliproxyapi-models.cpa-work.json",
        },
      ],
    });
    expect(loadEndpoints([], { CLIPROXYAPI_API_KEY: "env-key" })).toEqual({
      endpoints: [],
      warnings: [ignored],
    });
    expect(
      loadEndpoints([{ providerId: "cpa-a", apiKey: "k" }], { CLIPROXYAPI_API_KEY: " " }),
    ).toMatchObject({ warnings: [] });
  });

  it("rejects invalid array entries and duplicate provider ids without echoing secrets", () => {
    const loaded = loadEndpoints(
      [
        "nope",
        { apiKey: "k" },
        { providerId: "a\nSECRET", apiKey: "k" },
        { providerId: "cpa-a", apiKey: { secret: "leaked" } },
        { providerId: "cpa-b", apiKey: "k", baseUrl: { url: "secret-host" } },
        { providerId: "cpa-a", apiKey: "first", baseUrl: "https://a.example" },
        { providerId: "CPA-A", apiKey: "second", baseUrl: "https://b.example" },
        { providerId: "cpa-ok", apiKey: "ok", baseUrl: "" },
      ],
      {},
    );
    expect(loaded.endpoints.map((ep) => ep.providerId)).toEqual(["cpa-ok"]);
    expect(loaded.endpoints[0]).toMatchObject({
      accountId: "cpa-ok",
      rawKey: "ok",
      cacheFile: "cliproxyapi-models.cpa-ok.json",
    });
    expect(loaded.endpoints[0]?.baseUrl).toBeUndefined();
    const text = JSON.stringify(loaded.warnings);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("leaked");
    expect(text).not.toContain("secret-host");
    expect(loaded.warnings).toEqual([
      "[cliproxyapi] Skipping non-object endpoint.",
      "[cliproxyapi] Array endpoint is missing providerId; not registered.",
      '[cliproxyapi] Invalid providerId; use 1-64 characters starting with a letter or digit, then letters, digits, ".", "_", or "-". Endpoint not registered.',
      "[cliproxyapi] Endpoint cpa-a has no apiKey; not registered.",
      "[cliproxyapi] Endpoint cpa-b has an invalid baseUrl; not registered.",
      '[cliproxyapi] Duplicate provider ids "cpa-a", "CPA-A"; those endpoints were not registered.',
    ]);
  });
});
