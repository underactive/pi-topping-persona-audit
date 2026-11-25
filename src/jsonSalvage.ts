/** JSON salvage for LLM output — every parse that succeeds in one text, in precedence order. */

/**
 * Robustly extract a JSON array from LLM output: direct parse, fenced blocks,
 * bracket slice, then JSON-lines objects as a last resort.
 */
export function extractJsonArray(text: string): unknown[] | null {
  return extractJsonArrayCandidates(text)[0] ?? null;
}

/**
 * Every successful parse from the same text, in salvage-precedence order:
 * whole text, fenced blocks, bracket slice, then JSON-lines objects. A prose
 * final message can salvage a single stray object while the complete array
 * lives in another candidate, so callers that can score candidates should
 * inspect all of them rather than trusting the first.
 */
export function extractJsonArrayCandidates(text: string): unknown[][] {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    candidates.push((match[1] ?? "").trim());
  }
  const first = trimmed.indexOf("[");
  const last = trimmed.lastIndexOf("]");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  const results: unknown[][] = [];
  for (const candidate of candidates) {
    if (!candidate.startsWith("[")) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (Array.isArray(parsed)) results.push(parsed);
    } catch {
      /* try next candidate */
    }
  }

  const objects: unknown[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (l.startsWith("{") && l.endsWith("}")) {
      try {
        objects.push(JSON.parse(l));
      } catch {
        /* skip malformed line */
      }
    }
  }
  if (objects.length > 0) results.push(objects);
  return results;
}
