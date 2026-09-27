/** A parsed JSON value (one stream-json line, transcript entry or payload). */
export type Json = null | boolean | number | string | Json[] | JsonObject;

/** A parsed JSON object. */
export interface JsonObject {
  [key: string]: Json;
}

/** `true` for a plain JSON object (not an array, not null). */
export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value when it is a string, else `undefined`. */
export function asString(value: Json | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The value when it is an object, else `undefined`. */
export function asObject(value: Json | undefined): JsonObject | undefined {
  return isObject(value) ? value : undefined;
}

/** The value when it is an array, else an empty array. */
export function asArray(value: Json | undefined): Json[] {
  return Array.isArray(value) ? value : [];
}

/** Deep copy through JSON (fixture lines are plain JSON). */
export function clone<T extends Json>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Parses NDJSON text into objects, skipping blank lines. */
export function parseNdjson(text: string): JsonObject[] {
  const out: JsonObject[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const value: unknown = JSON.parse(line);
    if (!isObject(value)) throw new Error(`NDJSON line is not an object: ${line.slice(0, 80)}`);
    out.push(value);
  }
  return out;
}

/** `type` or `type/subtype` of a stream-json line, e.g. `system/init`, `assistant`. */
export function kindOf(line: JsonObject): string {
  const type = asString(line['type']) ?? '?';
  const subtype = asString(line['subtype']);
  return subtype ? `${type}/${subtype}` : type;
}
