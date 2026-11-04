import { exec } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createProvider,
  type Model,
  normalizeContext,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
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
const KEY_CACHE = Symbol.for("@getpie/pi-cliproxyapi-provider.keys");
const processState = globalThis as typeof globalThis & {
  [KEY_CACHE]?: Map<string, Promise<string | undefined>>;
};
// On globalThis: Pi re-imports this module (jiti moduleCache: false) on /reload and on cwd changes.
processState[KEY_CACHE] ??= new Map();
const keyCache = processState[KEY_CACHE];

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

/** Replaces our wrapped key with the real one; returns whether anything was rewritten. */
export function patchHeaders(headers: Headers): boolean {
  const real = unwrapAuth(headers.get("authorization"));
  if (!real) return false;
  headers.set("authorization", real);
  headers.delete("chatgpt-account-id");
  return true;
}

/** Returns whether Pi's WebSockets will carry the real key; false where globals are read-only. */
export function ensureWsPatch(): boolean {
  const ws = globalThis.WebSocket as (typeof WebSocket & { [WS_PATCHED]?: boolean }) | undefined;
  if (typeof ws !== "function") return false;
  if (ws[WS_PATCHED]) return true;
  const Patched = new Proxy(ws, {
    // A marker set on the Proxy would land on the native class, which stays global if assignment fails.
    get: (target, key) => key === WS_PATCHED || Reflect.get(target, key),
    construct(target, args, newTarget) {
      const init = args[1] && typeof args[1] === "object" ? args[1].headers : undefined;
      let headers: Headers | undefined;
      try {
        headers = init ? new Headers(init) : undefined;
      } catch {}
      // Only rewrite our own wrapped key (Pi passes a plain object); other WebSockets are untouched.
      if (headers && patchHeaders(headers)) {
        args = [args[0], { ...args[1], headers: Object.fromEntries(headers) }, ...args.slice(2)];
      }
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    // bun compile makes built-ins read-only for code loaded at runtime and throws here.
    globalThis.WebSocket = Patched;
  } catch {
    return false;
  }
  return globalThis.WebSocket === Patched;
}

export async function resolveKey(raw: string | undefined): Promise<string | undefined> {
  const s = raw?.trim();
  if (!s) return undefined;
  if (s.startsWith("!")) {
    const cmd = s.slice(1).trim();
    const cached = keyCache.get(cmd);
    if (cached) return cached;
    const pending = new Promise<string | undefined>((resolve, reject) => {
      const child = exec(cmd, { encoding: "utf8", timeout: 10_000 }, (error, stdout) => {
        if (error) {
          reject(error);
        } else {
          resolve(stdout.trim() || undefined);
        }
      });
      child.stdin?.end();
    })
      .then((key) => {
        if (!key && keyCache.get(cmd) === pending) keyCache.delete(cmd);
        return key;
      })
      .catch((error) => {
        // A stale run must not evict a newer entry started after /reload.
        if (keyCache.get(cmd) === pending) keyCache.delete(cmd);
        // Child-process errors can contain the command and secret output.
        throw new Error(error.killed ? "API key command timed out" : "API key command failed");
      });
    keyCache.set(cmd, pending);
    return pending;
  }
  const env = s.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)?.[1];
  return env ? process.env[env]?.trim() || undefined : s;
}

export function resolveEndpoints(baseUrl?: string) {
  const s = baseUrl?.trim() || "http://127.0.0.1:8317";
  const url = new URL(/^https?:\/\//i.test(s) ? s : `http://${s}`);
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
  const res = await fetchImpl(modelsUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`models HTTP ${res.status}`);
  const data = (await res.json()) as
    | { models?: RemoteModelItem[]; data?: RemoteModelItem[] }
    | RemoteModelItem[];
  const list = Array.isArray(data) ? data : (data.models ?? data.data ?? []);
  // Codex ModelVisibility is "list" | "hide" | "none"; only listed (or unspecified) models show.
  return list
    .filter((m) => (m?.visibility ?? "list") === "list" && (m?.slug || m?.id))
    .map((m) => {
      const id = String(m.slug ?? m.id).trim();
      const efforts = (m.supported_reasoning_levels ?? [])
        .map((e) =>
          String(typeof e === "string" ? e : (e?.effort ?? ""))
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean);
      // Pi hides levels mapped to null and omits the reasoning field when "off" maps to null.
      const level = (effort: string) => (efforts.includes(effort) ? effort : null);
      return {
        id,
        name: String(m.display_name ?? m.name ?? id).trim(),
        reasoning: efforts.length > 0,
        ...(efforts.length > 0 && {
          thinkingLevelMap: {
            off: level("none"),
            minimal: level("minimal"),
            low: level("low"),
            medium: level("medium"),
            high: level("high"),
            xhigh: level("xhigh"),
          },
        }),
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
  let cfg: Record<string, string | undefined> = {};
  try {
    cfg = JSON.parse(readFileSync(join(agentDir, "cliproxyapi.json"), "utf8")) ?? {};
  } catch {}
  // Empty env or config values count as unset.
  const setting = (env: string, key: string) =>
    process.env[env]?.trim() || String(cfg[key] ?? "").trim() || undefined;
  const providerId = setting("CLIPROXYAPI_PROVIDER_ID", "providerId") ?? "cpa";
  const providerName = setting("CLIPROXYAPI_PROVIDER_NAME", "providerName") ?? providerId;
  const rawKey = setting("CLIPROXYAPI_API_KEY", "apiKey");
  if (!rawKey) return;

  let endpoints: ReturnType<typeof resolveEndpoints>;
  try {
    endpoints = resolveEndpoints(setting("CLIPROXYAPI_BASE_URL", "baseUrl"));
  } catch {
    // Skip registration rather than crash extension loading; never print the URL itself.
    console.warn("[cliproxyapi] Invalid base URL; provider not registered.");
    return;
  }
  const { inferenceBaseUrl, modelsUrl } = endpoints;
  const cachePath = join(agentDir, "cliproxyapi-models.json");

  const streamSimple: ProviderStreams["streamSimple"] = (model, context, options) => {
    // Without the patch a WebSocket would send the wrapped key, so use SSE (via our fetch) instead.
    const wsReady = ensureWsPatch();
    return codexApi.streamSimple(
      model as Model<"openai-codex-responses">,
      normalizeContext(context),
      {
        ...options,
        ...(!wsReady && { transport: "sse" as const }),
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
  };

  const register = (models: ProviderModelConfig[]) => {
    pi.unregisterProvider(providerId);
    pi.registerProvider(
      createProvider({
        id: providerId,
        name: providerName,
        baseUrl: inferenceBaseUrl,
        auth: {
          apiKey: {
            name: providerName,
            check: async ({ credential }) => {
              const configured = credential
                ? credential.key
                : rawKey.startsWith("!") || (await resolveKey(rawKey));
              return configured ? { type: "api_key", source: "configured API key" } : undefined;
            },
            resolve: async ({ credential }) => {
              const key = credential ? credential.key : await resolveKey(rawKey);
              return key
                ? { auth: { apiKey: key }, env: credential?.env, source: "configured API key" }
                : undefined;
            },
          },
        },
        models: models.map((model) => ({
          ...model,
          provider: providerId,
          api: "openai-codex-responses" as const,
          baseUrl: inferenceBaseUrl,
        })),
        api: { stream: streamSimple, streamSimple },
      }),
    );
  };

  const refresh = async () => {
    const key = await resolveKey(rawKey);
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

  // Pi also re-runs this factory on /new, /resume and /fork; only /reload re-reads a command key.
  pi.on("session_start", (event) => {
    if (event.reason !== "reload" || !rawKey.startsWith("!")) return;
    keyCache.delete(rawKey.slice(1).trim());
    void resolveKey(rawKey).catch(() => {});
  });

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
      // Background refresh; for a command key this also prewarms it without blocking startup.
      void refresh().catch(() => {});
      return;
    }
  } catch {}

  await refresh().catch(() => {});
}
