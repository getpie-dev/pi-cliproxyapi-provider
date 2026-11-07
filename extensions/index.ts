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

const codexApi = openAICodexResponsesApi();
const KEY_CACHE = Symbol.for("@getpie/pi-cliproxyapi-provider.keys");
const processState = globalThis as typeof globalThis & {
  [KEY_CACHE]?: Map<string, Promise<string | undefined>>;
};
// On globalThis: Pi re-imports this module (jiti moduleCache: false) on /reload and on cwd changes.
processState[KEY_CACHE] ??= new Map();
const keyCache = processState[KEY_CACHE];
const LEGACY_CACHE_FILE = "cliproxyapi-models.json";

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

interface EndpointConfig {
  providerId: string;
  providerName: string;
  rawKey: string;
  baseUrl?: string;
}

interface ConfiguredEndpoint extends EndpointConfig {
  /** pi-ai caches Codex sockets by sessionId and this id, not by URL. */
  accountId: string;
  cacheFile: string;
}

interface RunningEndpoint {
  providerName: string;
  rawKey: string;
  refresh: () => Promise<ProviderModelConfig[]>;
  startup: () => Promise<void>;
}

export const wrapKey = (key: string, accountId = "cpa") =>
  `cpa_v1.${Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url")}.${Buffer.from(key, "utf8").toString("base64url")}`;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readEntry(entry: unknown, env: NodeJS.ProcessEnv): EndpointConfig | undefined {
  const cfg = isRecord(entry) ? entry : {};
  // Empty env or config values count as unset. Env wins, for an object and for every array entry.
  const setting = (name: string, key: string) =>
    env[name]?.trim() || String(cfg[key] ?? "").trim() || undefined;
  const rawKey = setting("CLIPROXYAPI_API_KEY", "apiKey");
  if (!rawKey) return undefined;
  const providerId = setting("CLIPROXYAPI_PROVIDER_ID", "providerId") ?? "cpa";
  return {
    providerId,
    providerName: setting("CLIPROXYAPI_PROVIDER_NAME", "providerName") ?? providerId,
    rawKey,
    baseUrl: setting("CLIPROXYAPI_BASE_URL", "baseUrl"),
  };
}

export function loadEndpoints(
  config: unknown,
  env: NodeJS.ProcessEnv,
): { endpoints: EndpointConfig[]; warnings: string[] } {
  const warnings: string[] = [];
  const byId = new Map<string, EndpointConfig>();
  for (const entry of Array.isArray(config) ? config : [config]) {
    const ep = readEntry(entry, env);
    if (!ep) continue;
    if (byId.has(ep.providerId)) {
      warnings.push(
        `[cliproxyapi] Provider id ${JSON.stringify(ep.providerId)} is configured more than once; the later endpoint replaces it.`,
      );
    }
    byId.set(ep.providerId, ep);
  }
  return { endpoints: [...byId.values()], warnings };
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

function bindEndpoint(
  pi: ExtensionAPI,
  agentDir: string,
  ep: ConfiguredEndpoint,
  urls: ReturnType<typeof resolveEndpoints>,
): RunningEndpoint {
  const { inferenceBaseUrl, modelsUrl } = urls;
  const cachePath = join(agentDir, ep.cacheFile);
  // The Codex transport needs a JWT-shaped token for the account id, so Authorization carries the
  // wrapped key; CLIProxyAPI skips it and accepts the real key from X-Api-Key on SSE and WebSocket.
  const streamSimple: ProviderStreams["streamSimple"] = (model, context, options) =>
    codexApi.streamSimple(model as Model<"openai-codex-responses">, normalizeContext(context), {
      ...options,
      ...(options?.apiKey && {
        apiKey: wrapKey(options.apiKey, ep.accountId),
        headers: { ...options.headers, "X-Api-Key": options.apiKey },
      }),
    });

  const register = (models: ProviderModelConfig[]) => {
    pi.unregisterProvider(ep.providerId);
    pi.registerProvider(
      createProvider({
        id: ep.providerId,
        name: ep.providerName,
        baseUrl: inferenceBaseUrl,
        auth: {
          apiKey: {
            name: ep.providerName,
            check: async ({ credential }) => {
              const configured = credential
                ? credential.key
                : ep.rawKey.startsWith("!") || (await resolveKey(ep.rawKey));
              return configured ? { type: "api_key", source: "configured API key" } : undefined;
            },
            resolve: async ({ credential }) => {
              const key = credential ? credential.key : await resolveKey(ep.rawKey);
              return key
                ? { auth: { apiKey: key }, env: credential?.env, source: "configured API key" }
                : undefined;
            },
          },
        },
        models: models.map((model) => ({
          ...model,
          provider: ep.providerId,
          api: "openai-codex-responses" as const,
          baseUrl: inferenceBaseUrl,
        })),
        api: { stream: streamSimple, streamSimple },
      }),
    );
  };

  const refresh = async () => {
    const key = await resolveKey(ep.rawKey);
    if (!key) throw new Error("Missing API key");
    const models = await fetchModels(modelsUrl, key);
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify({ modelsUrl, models }, null, 2)}\n`);
    register(models);
    return models;
  };

  const startup = async () => {
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
  };

  return { providerName: ep.providerName, rawKey: ep.rawKey, refresh, startup };
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const agentDir = getAgentDir();
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(readFileSync(join(agentDir, "cliproxyapi.json"), "utf8")) ?? {};
  } catch {}
  const loaded = loadEndpoints(parsed, process.env);
  for (const warning of loaded.warnings) console.warn(warning);
  if (loaded.endpoints.length === 0) return;

  const runnable: { ep: EndpointConfig; urls: ReturnType<typeof resolveEndpoints> }[] = [];
  for (const ep of loaded.endpoints) {
    try {
      runnable.push({ ep, urls: resolveEndpoints(ep.baseUrl) });
    } catch {
      // Skip registration rather than crash extension loading; never print the URL itself.
      console.warn("[cliproxyapi] Invalid base URL; provider not registered.");
    }
  }
  if (runnable.length === 0) return;

  // One provider keeps the historical socket account id and catalog file.
  const alone = runnable.length === 1;
  const running: RunningEndpoint[] = [];
  for (const { ep, urls } of runnable) {
    running.push(
      bindEndpoint(
        pi,
        agentDir,
        {
          ...ep,
          accountId: alone ? "cpa" : ep.providerId.replace(/[\r\n]/g, "") || "cpa",
          cacheFile: alone
            ? LEGACY_CACHE_FILE
            : `cliproxyapi-models.${Buffer.from(ep.providerId).toString("base64url")}.json`,
        },
        urls,
      ),
    );
  }

  const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));
  pi.registerCommand("cliproxyapi-refresh", {
    description: "Refresh CLIProxyAPI models from remote catalog.",
    handler: async (_args, ctx) => {
      const results = await Promise.all(
        running.map(async (ep) => {
          try {
            const models = await ep.refresh();
            return { ok: true, text: `Refreshed ${models.length} ${ep.providerName} models.` };
          } catch (error) {
            const message = failure(error);
            return {
              ok: false,
              text:
                running.length === 1
                  ? `Refresh failed: ${message}`
                  : `Refresh failed for ${ep.providerName}: ${message}`,
            };
          }
        }),
      );
      ctx.ui.notify(
        results.map((result) => result.text).join(" "),
        results.every((result) => result.ok) ? "info" : "error",
      );
    },
  });

  // Pi also re-runs this factory on /new, /resume and /fork; only /reload re-reads a command key.
  pi.on("session_start", (event) => {
    if (event.reason !== "reload") return;
    for (const ep of running) {
      if (!ep.rawKey.startsWith("!")) continue;
      keyCache.delete(ep.rawKey.slice(1).trim());
      void resolveKey(ep.rawKey).catch(() => {});
    }
  });

  await Promise.all(running.map((ep) => ep.startup()));
}
