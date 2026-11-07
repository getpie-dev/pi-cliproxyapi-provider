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
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OVERRIDE_ENV = [
  "CLIPROXYAPI_API_KEY",
  "CLIPROXYAPI_BASE_URL",
  "CLIPROXYAPI_PROVIDER_ID",
  "CLIPROXYAPI_PROVIDER_NAME",
] as const;

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

interface ConfiguredEndpoint {
  providerId: string;
  providerName: string;
  /** pi-ai caches Codex sockets by sessionId and this id, not by URL. */
  accountId: string;
  rawKey: string;
  baseUrl?: string;
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

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  // Empty env values count as unset.
  return env[name]?.trim() || undefined;
}

function coerced(value: unknown): string | undefined {
  return String(value ?? "").trim() || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function loadObject(config: unknown, env: NodeJS.ProcessEnv): ConfiguredEndpoint[] {
  const cfg = isRecord(config) ? config : {};
  const setting = (name: string, key: string) => envValue(env, name) || coerced(cfg[key]);
  const rawKey = setting("CLIPROXYAPI_API_KEY", "apiKey");
  if (!rawKey) return [];
  const providerId = setting("CLIPROXYAPI_PROVIDER_ID", "providerId") ?? "cpa";
  return [
    {
      providerId,
      providerName: setting("CLIPROXYAPI_PROVIDER_NAME", "providerName") ?? providerId,
      // Single-object configs keep the historical account id.
      accountId: "cpa",
      rawKey,
      baseUrl: setting("CLIPROXYAPI_BASE_URL", "baseUrl"),
      cacheFile: LEGACY_CACHE_FILE,
    },
  ];
}

function loadArray(
  items: unknown[],
  env: NodeJS.ProcessEnv,
): { endpoints: ConfiguredEndpoint[]; warnings: string[] } {
  const warnings: string[] = [];
  // One env value must not retarget every endpoint. Per-entry $ENV and !command still work.
  if (OVERRIDE_ENV.some((name) => envValue(env, name))) {
    warnings.push(
      "[cliproxyapi] CLIPROXYAPI_* environment overrides are ignored for array configs.",
    );
  }
  const parsed: ConfiguredEndpoint[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      warnings.push("[cliproxyapi] Skipping non-object endpoint.");
      continue;
    }
    if (typeof item.providerId !== "string" || !item.providerId.trim()) {
      warnings.push("[cliproxyapi] Array endpoint is missing providerId; not registered.");
      continue;
    }
    const providerId = item.providerId.trim();
    if (!PROVIDER_ID.test(providerId)) {
      warnings.push(
        '[cliproxyapi] Invalid providerId; use 1-64 characters starting with a letter or digit, then letters, digits, ".", "_", or "-". Endpoint not registered.',
      );
      continue;
    }
    if (typeof item.apiKey !== "string" || !item.apiKey.trim()) {
      warnings.push(`[cliproxyapi] Endpoint ${providerId} has no apiKey; not registered.`);
      continue;
    }
    let baseUrl: string | undefined;
    if (item.baseUrl != null) {
      if (typeof item.baseUrl !== "string") {
        warnings.push(
          `[cliproxyapi] Endpoint ${providerId} has an invalid baseUrl; not registered.`,
        );
        continue;
      }
      baseUrl = item.baseUrl.trim() || undefined;
    }
    const providerName =
      typeof item.providerName === "string" && item.providerName.trim()
        ? item.providerName.trim()
        : providerId;
    parsed.push({
      providerId,
      providerName,
      accountId: providerId,
      rawKey: item.apiKey.trim(),
      baseUrl,
      cacheFile: `cliproxyapi-models.${providerId}.json`,
    });
  }
  const counts = new Map<string, number>();
  for (const ep of parsed) {
    const key = ep.providerId.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const dupes = [
    ...new Set(
      parsed
        .filter((ep) => (counts.get(ep.providerId.toLowerCase()) ?? 0) > 1)
        .map((ep) => ep.providerId),
    ),
  ];
  if (dupes.length > 0) {
    warnings.push(
      `[cliproxyapi] Duplicate provider ${dupes.length === 1 ? "id" : "ids"} ${dupes
        .map((id) => JSON.stringify(id))
        .join(", ")}; those endpoints were not registered.`,
    );
  }
  return {
    endpoints: parsed.filter((ep) => counts.get(ep.providerId.toLowerCase()) === 1),
    warnings,
  };
}

export function loadEndpoints(
  config: unknown,
  env: NodeJS.ProcessEnv,
): { endpoints: ConfiguredEndpoint[]; warnings: string[] } {
  if (Array.isArray(config)) return loadArray(config, env);
  return { endpoints: loadObject(config, env), warnings: [] };
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

  const running: RunningEndpoint[] = [];
  for (const ep of loaded.endpoints) {
    let urls: ReturnType<typeof resolveEndpoints>;
    try {
      urls = resolveEndpoints(ep.baseUrl);
    } catch {
      // Skip registration rather than crash extension loading; never print the URL itself.
      console.warn(
        ep.cacheFile === LEGACY_CACHE_FILE
          ? "[cliproxyapi] Invalid base URL; provider not registered."
          : `[cliproxyapi] Invalid base URL for ${ep.providerId}; provider not registered.`,
      );
      continue;
    }
    running.push(bindEndpoint(pi, agentDir, ep, urls));
  }
  if (running.length === 0) return;

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
