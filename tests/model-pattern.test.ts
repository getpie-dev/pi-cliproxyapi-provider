import { minimatch } from "minimatch";
import { describe, expect, it } from "vitest";
import { omitDisabledModels } from "../extensions/model-pattern.ts";

const OPTIONS = { nocase: true };
const IDS = [
  ".hidden",
  "foo/.bar",
  "gpt-4o",
  "gpt-5.4",
  "org/model",
  "a/b/c",
  "model1",
  "modelm",
  "foo*bar",
  "foobar",
  "claude-sonnet-4-5",
];

function hidden(patterns: readonly string[], ids: readonly string[] = IDS, provider = "cpa") {
  const models = ids.map((id) => ({ id }));
  const kept = new Set(omitDisabledModels(models, provider, patterns).map((model) => model.id));
  return ids.filter((id) => !kept.has(id));
}

describe("disabledModels Pi minimatch semantics", () => {
  it("agrees with nocase minimatch on provider/id and the bare id for globs", () => {
    const patterns = [
      "*",
      "**",
      "*/*",
      "**/gpt-*",
      "cpa/**",
      "gpt-{4,5}*",
      "gpt-@(4|5)*",
      "model[1m]",
      "foo\\*bar",
      "a/**/c",
      "a**b",
      "*sonnet*",
      "foo/.*",
      ".h*",
      "gpt-5.?",
      "OpenAI/*",
    ];
    for (const pattern of patterns) {
      const expected = IDS.filter(
        (id) => minimatch(`cpa/${id}`, pattern, OPTIONS) || minimatch(id, pattern, OPTIONS),
      );
      expect(hidden([pattern]), pattern).toEqual(expected);
    }
  });

  it.each([
    ["*", [".hidden", "foo/.bar", "org/model", "gpt-5.4"], ["gpt-5.4"]],
    [".h*", [".hidden", "gpt-5.4"], [".hidden"]],
    ["foo/.*", ["foo/.bar", "foo/bar"], ["foo/.bar"]],
    ["**", [".hidden", "org/model", "gpt-5.4"], ["org/model", "gpt-5.4"]],
    ["*/*", ["gpt-5.4", "org/model", "a/b/c"], ["gpt-5.4", "org/model"]],
    ["cpa/**", ["gpt-5.4", "org/model", ".hidden"], ["gpt-5.4", "org/model"]],
    ["a/**/c", ["a/b/c", "a/c", "ac"], ["a/b/c", "a/c"]],
    ["a**b", ["ab", "axb", "a/x/b"], ["ab", "axb"]],
    ["gpt-{4,5}*", ["gpt-4o", "gpt-5.4", "claude-sonnet-4-5"], ["gpt-4o", "gpt-5.4"]],
    ["gpt-@(4|5)*", ["gpt-4o", "gpt-5.4", "claude-sonnet-4-5"], ["gpt-4o", "gpt-5.4"]],
    ["model[1m]", ["model1", "modelm", "modelx"], ["model1", "modelm"]],
    ["foo\\*bar", ["foo*bar", "foobar"], ["foo*bar"]],
    ["*SONNET*", ["Claude-Sonnet-4", "gpt-5.4"], ["Claude-Sonnet-4"]],
  ])("glob %j hides %j", (pattern, ids, expected) => {
    expect(hidden([pattern], ids)).toEqual(expected);
  });

  it("prefers an exact bracketed id over the character class", () => {
    expect(hidden(["model[1m]"], ["model[1m]", "model1", "modelm"])).toEqual(["model[1m]"]);
    expect(minimatch("model1", "model[1m]", OPTIONS)).toBe(true);
  });

  it("keeps non-glob braces, extglobs, fuzzy names, and thinking suffixes literal", () => {
    const ids = ["gpt-4o", "gpt-5.4", "claude-sonnet-4-5", "gpt-4o:high"];
    expect(hidden(["{gpt-4o,gpt-5.4}"], ids)).toEqual([]);
    expect(hidden(["@(gpt-4o|gpt-5.4)"], ids)).toEqual([]);
    expect(minimatch("gpt-4o", "{gpt-4o,gpt-5.4}", OPTIONS)).toBe(true);
    expect(hidden(["sonnet"], ids)).toEqual([]);
    expect(hidden(["gpt-4o:high"], ids)).toEqual(["gpt-4o:high"]);
    expect(hidden(["cpa/*:high"], ["gpt-4o", "gpt-5.4"])).toEqual([]);
    expect(hidden(["cpa/*:high"], ["gpt-4o:high"])).toEqual(["gpt-4o:high"]);
    expect(hidden(["gpt-5.4"], ["gpt-5.4", "gpt-5.4-mini"])).toEqual(["gpt-5.4"]);
    expect(hidden(["CPA/gpt-5.4"], ["gpt-5.4"])).toEqual(["gpt-5.4"]);
    expect(hidden(["other/gpt-5.4"], ["gpt-5.4"])).toEqual([]);
    expect(hidden(["other/gpt-5.4"], ["other/gpt-5.4"])).toEqual(["other/gpt-5.4"]);
  });

  it("ors patterns and leaves an omitted list unchanged", () => {
    expect(hidden(["gpt-4o", "*sonnet*"])).toEqual(["gpt-4o", "claude-sonnet-4-5"]);
    expect(
      omitDisabledModels(
        IDS.map((id) => ({ id })),
        "cpa",
      ).map((model) => model.id),
    ).toEqual(IDS);
    expect(
      omitDisabledModels(
        IDS.map((id) => ({ id })),
        "cpa",
        [],
      ).map((model) => model.id),
    ).toEqual(IDS);
  });
});
