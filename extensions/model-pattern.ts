// shortcut: not minimatch character classes, braces, extglobs, escapes, or dotfile rules; add them only if a catalog needs them.

/** Case-insensitive Pi 1.5 model glob (`*`, `?`, segment `**`) against `provider/id` and the bare id. */
export function matchesModelPattern(pattern: string, providerId: string, modelId: string): boolean {
  const spec = pattern.trim();
  if (!spec || !modelId.trim()) return false;
  const targets = [`${providerId}/${modelId}`, modelId];
  if (targets.some((target) => target.toLowerCase() === spec.toLowerCase())) return true;
  // A literal `[` is not a character class. Exact equality above already matched ids that contain one.
  if (!spec.includes("*") && !spec.includes("?")) return false;
  return targets.some((target) => new RegExp(`^${globSource(spec)}$`, "i").test(target));
}

/** `*` and `?` stay inside one `/` segment. `**` crosses `/` only as a whole segment, like minimatch. */
function globSource(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      let stars = 1;
      while (pattern[i + 1] === "*") {
        stars++;
        i++;
      }
      const start = i - stars + 1;
      const boundaryBefore = start === 0 || pattern[start - 1] === "/";
      const next = pattern[i + 1];
      if (stars === 2 && boundaryBefore && (next === undefined || next === "/")) {
        if (next === "/") {
          out += "(?:.*/)?";
          i++;
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      continue;
    }
    out += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return out;
}
