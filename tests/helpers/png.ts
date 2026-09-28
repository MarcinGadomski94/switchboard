/** The 8-byte signature every PNG starts with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Width and height of a PNG, read from its IHDR chunk (the first chunk, right
 * after the signature: length, `IHDR`, width, height as big-endian uint32).
 * @throws {Error} when `data` is not a PNG.
 */
export function pngSize(data: Buffer): { width: number; height: number } {
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG (bad signature)');
  if (data.toString('latin1', 12, 16) !== 'IHDR') throw new Error('not a PNG (no IHDR first)');
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}
