import { randomUUID } from 'node:crypto';
import type { ToolInput } from '../db/repos/tools.ts';
import type { FieldError } from '../sessions/validate.ts';

/** Result of {@link validateTools}. */
export type ToolsValidation = { readonly ok: true; readonly value: ToolInput[] } | { readonly ok: false; readonly errors: FieldError[] };

/** Tool ids: they appear in `/tools/:id` and `/api/tools/:id/probe`. */
export const TOOL_ID = /^[A-Za-z0-9_-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A tool URL as saved: blank → `null` (not configured); otherwise an absolute
 * `http:` or `https:` URL (ARCHITECTURE → Security: iframes load only URLs
 * configured in Settings, and the probe only fetches saved URLs). Returns
 * `undefined` for anything else.
 */
export function normalizeToolUrl(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '') return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username || url.password) return undefined;
  return text;
}

/**
 * Validates a `PUT /api/tools` body: the whole list, in display order (gap #14:
 * tools can be added and removed). Each item has a non-empty `name`, an optional
 * `url` ({@link normalizeToolUrl}), an optional `description` (blank → `null`), an
 * optional `showInSidebar` (default `true`) and an optional `id` (generated for a
 * new tool; unique in the list). Unknown fields are ignored.
 */
export function validateTools(body: unknown): ToolsValidation {
  if (!Array.isArray(body)) return { ok: false, errors: [{ field: '', message: 'the body must be the list of tools' }] };
  const errors: FieldError[] = [];
  const value: ToolInput[] = [];
  const ids = new Set<string>();
  body.forEach((item, index) => {
    const at = (field: string): string => `[${index}].${field}`;
    if (!isRecord(item)) {
      errors.push({ field: `[${index}]`, message: 'each tool must be an object' });
      return;
    }
    let id = item['id'];
    if (id === undefined || id === null || id === '') id = randomUUID();
    if (typeof id !== 'string' || !TOOL_ID.test(id)) {
      errors.push({ field: at('id'), message: 'the id must be 1–64 letters, digits, "-" or "_"' });
    } else if (ids.has(id)) {
      errors.push({ field: at('id'), message: `the id "${id}" is used twice` });
    } else {
      ids.add(id);
    }
    const name = typeof item['name'] === 'string' ? item['name'].trim() : '';
    if (name === '' || name.length > 80) errors.push({ field: at('name'), message: 'the name must be 1–80 characters' });
    const url = normalizeToolUrl(item['url']);
    if (url === undefined) errors.push({ field: at('url'), message: 'the URL must be an http:// or https:// address' });
    const rawDescription = item['description'];
    if (rawDescription !== undefined && rawDescription !== null && typeof rawDescription !== 'string') {
      errors.push({ field: at('description'), message: 'the description must be text' });
    }
    const description = typeof rawDescription === 'string' && rawDescription.trim() !== '' ? rawDescription.trim() : null;
    const showInSidebar = item['showInSidebar'] ?? true;
    if (typeof showInSidebar !== 'boolean') errors.push({ field: at('showInSidebar'), message: 'showInSidebar must be true or false' });
    if (typeof id === 'string' && url !== undefined && typeof showInSidebar === 'boolean') {
      value.push({ id, name, url, description, showInSidebar });
    }
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}
