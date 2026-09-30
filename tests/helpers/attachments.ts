/** D57 test data: the smallest real files the attachment rules sniff. */

/** A 1×1 PNG (base64). */
export const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** A two-page PDF skeleton (text; enough for the magic bytes and the page count). */
export const PDF_TEXT =
  '%PDF-1.4\n1 0 obj<</Type /Catalog /Pages 2 0 R>>endobj 2 0 obj<</Type /Pages /Kids[3 0 R 4 0 R]/Count 2>>endobj 3 0 obj<</Type /Page /Parent 2 0 R>>endobj 4 0 obj<</Type/Page/Parent 2 0 R>>endobj\n%%EOF';

/** An SVG with a script (must never be served as an image). */
export const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

/** `text` as base64. */
export function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}
