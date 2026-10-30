import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupSessionResources, type Model, normalizeContext } from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/compat";
import {
  type ExtensionAPI,
  getAgentDir,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

const JWT_CLAIM = Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "cpa" } }),
).toString("base64url");
const WS_PATCHED = Symbol.for("@getpie/pi-cliproxyapi-provider.ws");
const codexApi = openAICodexResponsesApi();

export interface RemoteModelItem {
  slug?: string;
  id?: string;
  display_name?: string;
  name?: string;
  visibility?: string;
  context_window?: number;
  max_context_window?: number;
  max_tokens?: number;
  max_output_tokens?: number;
  max_completion_tokens?: number;
  input_modalities?: string[];
  supported_reasoning_levels?: Array<{ effort?: string } | string>;
}

export const wrapKey = (key: string) =>
  `cpa_v1.${JWT_CLAIM}.${Buffer.from(key, "utf8").toString("base64url")}`;

export function unwrapAuth(value: string | null | undefined): string | undefined {
  const m = value?.match(/^Bearer\s+cpa_v1\.[^.]+\.([A-Za-z0-9_-]+)$/i);
  return m?.[1] ? `Bearer ${Buffer.from(m[1], "base64url").toString("utf8")}` : undefined;
}

export function patchHeaders(headers: Headers | Record<string, string> | undefined): void {
  if (!headers) return;
  if (headers instanceof Headers) {
    const real = unwrapAuth(headers.get("authorization"));
    if (real) {
      headers.set("authorization", real);
      headers.delete("chatgpt-account-id");
    }
    return;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "authorization") {
      const real = unwrapAuth(v);
      if (real) {
        headers[k] = real;
        delete headers["chatgpt-account-id"];
      }
    }
  }
}

function ensureWsPatch(): void {
  const ws = globalThis.WebSocket as (typeof WebSocket & { [WS_PATCHED]?: boolean }) | undefined;
  if (typeof ws !== "function" || ws[WS_PATCHED]) return;
  const Patched = new Proxy(ws, {
    construct(target, args, newTarget) {
      if (args[1] && typeof args[1] === "object" && !Array.isArray(args[1]) && args[1].headers) {
        const headers =
          args[1].headers instanceof Headers
            ? new Headers(args[1].headers)
            : { ...args[1].headers };
        patchHeaders(headers);
        args = [args[0], { ...args[1], headers }, ...args.slice(2)];
      }
      return Reflect.construct(target, args, newTarget);
    },
  }) as typeof WebSocket & { [WS_PATCHED]?: boolean };
  Patched[WS_PATCHED] = true;
  globalThis.WebSocket = Patched;
}

export function resolveKey(raw: string | undefined): string | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  if (s.startsWith("!")) {
    return (
      execSync(s.slice(1), {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined
    );
  }
  const env = s.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)?.[1];
  return env ? process.env[env]?.trim() || undefined : s;
}

export function resolveEndpoints(baseUrl = "http://127.0.0.1:8317") {
  const url = new URL(
    /^https?:\/\//i.test(baseUrl.trim()) ? baseUrl.trim() : `http://${baseUrl.trim()}`,
  );
  const root = url.pathname.replace(/\/+$/, "").replace(/\/(?:v1|backend-api)$/, "");
  return {
    inferenceBaseUrl: `${url.origin}${root}/backend-api/`,
    modelsUrl: `${url.origin}${root}/v1/models?client_version=pi`,
  };
}

export async function fetchModels(
  modelsUrl: string,
  apiKey: string,
  fetchImpl = globalThis.fetch,
): Promise<ProviderModelConfig[]> {
  const res = await fetchImpl(modelsUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`models HTTP ${res.status}`);
  const data = (await res.json()) as
    | { models?: RemoteModelItem[]; data?: RemoteModelItem[] }
    | RemoteModelItem[];
  const list = Array.isArray(data) ? data : (data.models ?? data.data ?? []);
  return list
    .filter((m) => m?.visibility !== "hide" && (m?.slug || m?.id))
    .map((m) => {
      const id = String(m.slug ?? m.id).trim();
      const efforts = (m.supported_reasoning_levels ?? [])
        .map((e) =>
          String(typeof e === "string" ? e : (e?.effort ?? ""))
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean);
      return {
        id,
        name: String(m.display_name ?? m.name ?? id).trim(),
        reasoning: efforts.length > 0,
        input: (m.input_modalities ?? []).some((x) => String(x).toLowerCase() === "image")
          ? (["text", "image"] as Array<"text" | "image">)
          : (["text"] as Array<"text" | "image">),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: m.context_window ?? m.max_context_window ?? 128_000,
        maxTokens: m.max_tokens ?? m.max_output_tokens ?? m.max_completion_tokens ?? 16_384,
      };
    });
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const agentDir = getAgentDir();
  const readCfg = (): Record<string, string | undefined> => {
    try {
      return JSON.parse(readFileSync(join(agentDir, "cliproxyapi.json"), "utf8"));
    } catch {
      return {};
    }
  };
  const cfg = readCfg();
  const providerId = String(process.env.CLIPROXYAPI_PROVIDER_ID ?? cfg.providerId ?? "cpa").trim();
  const providerName = String(
    process.env.CLIPROXYAPI_PROVIDER_NAME ?? cfg.providerName ?? providerId,
  ).trim();
  const rawKey = String(process.env.CLIPROXYAPI_API_KEY ?? cfg.apiKey ?? "").trim();
  if (!rawKey) return;

  const { inferenceBaseUrl, modelsUrl } = resolveEndpoints(
    process.env.CLIPROXYAPI_BASE_URL ?? cfg.baseUrl,
  );
  const cachePath = join(agentDir, "cliproxyapi-models.json");

  const register = (models: ProviderModelConfig[]) => {
    pi.unregisterProvider(providerId);
    pi.registerProvider(providerId, {
      name: providerName,
      baseUrl: inferenceBaseUrl,
      api: "openai-codex-responses",
      apiKey: rawKey,
      models,
      streamSimple: (model, context, options) => {
        ensureWsPatch();
        return codexApi.streamSimple(
          model as Model<"openai-codex-responses">,
          normalizeContext(context),
          {
            ...options,
            ...(options?.apiKey ? { apiKey: wrapKey(options.apiKey) } : {}),
            fetch: async (input, init) => {
              if (init?.headers) {
                const headers = new Headers(init.headers);
                patchHeaders(headers);
                init = { ...init, headers };
              }
              return (options?.fetch ?? globalThis.fetch)(input, init);
            },
          },
        );
      },
    });
  };

  const refresh = async () => {
    const key = resolveKey(process.env.CLIPROXYAPI_API_KEY ?? readCfg().apiKey);
    if (!key) throw new Error("Missing API key");
    const models = await fetchModels(modelsUrl, key);
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify({ modelsUrl, models }, null, 2)}\n`);
    register(models);
    return models;
  };

  pi.registerCommand("cliproxyapi-refresh", {
    description: "Refresh CLIProxyAPI models from remote catalog.",
    handler: async (_args, ctx) => {
      try {
        const models = await refresh();
        ctx.ui.notify(`Refreshed ${models.length} ${providerName} models.`, "info");
      } catch (e) {
        ctx.ui.notify(`Refresh failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  pi.on("session_compact", () => cleanupSessionResources());
  pi.on("session_shutdown", () => cleanupSessionResources());

  try {
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as {
      modelsUrl?: string;
      models?: ProviderModelConfig[];
    };
    if (
      cached?.modelsUrl === modelsUrl &&
      Array.isArray(cached.models) &&
      cached.models.length > 0
    ) {
      register(cached.models);
      void refresh().catch(() => {});
      return;
    }
  } catch {}

  await refresh().catch(() => {});
}
