import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveKey } from "../extensions/index.ts";

let dir: string;
let scriptId = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-cpa-keys-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function command(body: string) {
  const script = join(dir, `script-${scriptId++}.cjs`);
  const marker = `${script}.runs`;
  writeFileSync(
    script,
    `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x");
${body}`,
  );
  return { raw: `!exec "${process.execPath}" "${script}"`, marker };
}

describe("asynchronous command credentials", () => {
  it("stays responsive, deduplicates concurrent calls, and caches success across reloads", async () => {
    const { raw, marker } = command(
      'setTimeout(() => process.stdout.write("  synthetic-key\\n"), 350)',
    );
    let settled = false;
    const first = resolveKey(raw).then((key) => {
      settled = true;
      return key;
    });
    const second = resolveKey(`  ${raw}  `);
    await delay(25);
    expect(settled).toBe(false);
    expect(await Promise.all([first, second])).toEqual(["synthetic-key", "synthetic-key"]);
    expect(await resolveKey(raw)).toBe("synthetic-key");
    vi.resetModules();
    const reloaded = await import("../extensions/index.ts");
    expect(await reloaded.resolveKey(raw)).toBe("synthetic-key");
    expect(readFileSync(marker, "utf8")).toBe("x");
  });

  it("clears successful credentials only in a new process", async () => {
    const value = join(dir, "rotating-key");
    writeFileSync(value, "old-key");
    const { raw, marker } = command(
      `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(value)}, "utf8"))`,
    );
    expect(await resolveKey(raw)).toBe("old-key");
    writeFileSync(value, "rotated-key");
    expect(await resolveKey(raw)).toBe("old-key");
    const moduleUrl = new URL("../extensions/index.ts", import.meta.url).href;
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const { resolveKey } = await import(${JSON.stringify(moduleUrl)});
         process.stdout.write(await resolveKey(${JSON.stringify(raw)}) ?? "");`,
        ],
        { env: { PATH: process.env.PATH, HOME: dir } },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        },
      );
    });
    expect(output).toBe("rotated-key");
    expect(readFileSync(marker, "utf8")).toBe("xx");
  });

  it("evicts failed executions, redacts errors, and retries with one shared execution", async () => {
    const gate = join(dir, "ready");
    const { raw, marker } = command(`
      if (!require("node:fs").existsSync(${JSON.stringify(gate)})) {
        process.stdout.write("secret-stdout");
        process.stderr.write("secret-stderr");
        process.exit(1);
      }
      process.stdout.write("recovered-key");
    `);
    const results = await Promise.allSettled([resolveKey(raw), resolveKey(raw)]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toEqual(new Error("API key command failed"));
        expect(result.reason.cause).toBeUndefined();
        expect(String(result.reason)).not.toContain(raw);
        expect(String(result.reason)).not.toContain("secret-");
      }
    }
    expect(readFileSync(marker, "utf8")).toBe("x");
    writeFileSync(gate, "ready");
    expect(await resolveKey(raw)).toBe("recovered-key");
    expect(await resolveKey(raw)).toBe("recovered-key");
    expect(readFileSync(marker, "utf8")).toBe("xx");
  });

  it("does not cache empty or whitespace-only output", async () => {
    const value = join(dir, "value");
    writeFileSync(value, "  \n");
    const { raw, marker } = command(
      `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(value)}, "utf8"))`,
    );
    expect(await resolveKey(raw)).toBeUndefined();
    writeFileSync(value, "now-a-key");
    expect(await resolveKey(raw)).toBe("now-a-key");
    expect(readFileSync(marker, "utf8")).toBe("xx");
  });

  it("times out after ten seconds without leaking output and permits retry", async () => {
    const gate = join(dir, "ready");
    const { raw, marker } = command(`
      if (require("node:fs").existsSync(${JSON.stringify(gate)})) process.stdout.write("retry-key");
      else { process.stderr.write("secret-timeout"); setInterval(() => {}, 1000); }
    `);
    const pending = resolveKey(raw);
    await delay(25);
    expect(existsSync(gate)).toBe(false);
    await expect(pending).rejects.toThrow("API key command timed out");
    writeFileSync(gate, "ready");
    expect(await resolveKey(raw)).toBe("retry-key");
    expect(readFileSync(marker, "utf8")).toBe("xx");
  }, 15_000);
});
