export function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function tryParseCandidate(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function extractJson(text: string) {
  const trimmed = text.trim();
  const direct = tryParseCandidate(trimmed);
  if (direct !== null) {
    return direct;
  }

  const fencedMatch = trimmed.match(/```json\s*([\s\S]*?)```/i) || trimmed.match(/```\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    const fenced = tryParseCandidate(fencedMatch[1].trim());
    if (fenced !== null) {
      return fenced;
    }
  }

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        const candidate = trimmed.slice(start, index + 1);
        const parsed = tryParseCandidate(candidate);
        if (parsed !== null) {
          return parsed;
        }
        start = -1;
      }
    }
  }

  throw new Error(`Could not extract valid JSON from model response:\n${trimmed.slice(0, 2000)}`);
}
