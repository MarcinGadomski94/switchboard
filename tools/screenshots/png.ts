/**
 * A minimal PNG decoder for the screenshot tools: 8-bit RGB or RGBA, not interlaced, which is
 * what Chromium's screenshots are. Returns RGBA pixels. No dependency beyond `node:zlib`.
 */
import { inflateSync } from 'node:zlib';

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes a pixel, rows top to bottom. */
  readonly rgba: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(file: Buffer): DecodedPng {
  if (!file.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Buffer[] = [];
  for (let at = 8; at < file.length; ) {
    const length = file.readUInt32BE(at);
    const type = file.toString('latin1', at + 4, at + 8);
    const body = file.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colorType = body[9];
      const interlace = body[12];
      if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`unsupported PNG (depth ${depth}, color type ${colorType}, interlace ${interlace})`);
      }
      channels = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x] ?? 0;
      const left = x >= channels ? (rows[out + x - channels] ?? 0) : 0;
      const up = y > 0 ? (rows[out - stride + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= channels ? (rows[out - stride + x - channels] ?? 0) : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) predicted = paeth(left, up, upLeft);
      rows[out + x] = (value + predicted) & 0xff;
    }
  }
  if (channels === 4) return { width, height, rgba: rows };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < rows.length; i += 3, j += 4) {
    rgba[j] = rows[i] ?? 0;
    rgba[j + 1] = rows[i + 1] ?? 0;
    rgba[j + 2] = rows[i + 2] ?? 0;
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}
