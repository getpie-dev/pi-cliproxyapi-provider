import { describe, expect, it } from "vitest";
import { matchesModelPattern } from "../extensions/model-pattern.ts";

describe("Pi model-pattern subset", () => {
  it.each([
    ["gpt-5.4", "cpa", "gpt-5.4", true],
    ["GPT-5.4", "other", "gpt-5.4", true],
    ["CPA/GPT-5.4", "cpa", "gpt-5.4", true],
    ["other/gpt-5.4", "cpa", "gpt-5.4", false],
    ["Pretty/gpt-5.4", "cpa", "gpt-5.4", false],
    ["gpt-5.4", "cpa", "gpt-5.4-mini", false],
    ["sonnet", "cpa", "claude-sonnet-4-5", false],
    ["*sonnet*", "cpa", "claude-sonnet-4-5", true],
    ["*SONNET*", "cpa", "Claude-Sonnet-4", true],
    ["  *sonnet*  ", "cpa", "claude-sonnet-4-5", true],
    ["cpa/gpt-*", "cpa", "gpt-5.4", true],
    ["cpa/gpt-*", "cpa", "claude-sonnet-4-5", false],
    ["*/gpt-5.4", "tcpa", "gpt-5.4", true],
    ["*", "cpa", "gpt-5.4", true],
    ["*", "cpa", "org/model", false],
    ["*/*", "cpa", "org/model", true],
    ["**", "cpa", "org/model", true],
    ["cpa/**", "cpa", "org/model", true],
    ["**/gpt-*", "cpa", "openai/gpt-5", true],
    ["a**b", "cpa", "a/x/b", false],
    ["gpt-5.?", "cpa", "gpt-5.4", true],
    ["gpt-5.?", "cpa", "gpt-5.45", false],
    ["i?", "cpa", "id", true],
    ["i?", "cpa", "i/d", false],
    ["gpt-4o:high", "cpa", "gpt-4o", false],
    ["gpt-4o:high", "cpa", "gpt-4o:high", true],
    ["model[1m]", "cpa", "model[1m]", true],
    ["model[1m]", "cpa", "model1", false],
    ["*/model[1m]", "cpa", "model[1m]", true],
    ["Mini", "cpa", "gpt-5.4-mini", false],
  ])("%j against %s/%s -> %s", (pattern, provider, id, expected) => {
    expect(matchesModelPattern(pattern, provider, id)).toBe(expected);
  });
});
