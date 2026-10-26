/** The parts of `gifenc` (dev dependency, no bundled types) that `demo-video.ts` uses. */
declare module 'gifenc' {
  export type Palette = number[][];
  export interface FrameOptions {
    palette?: Palette;
    delay?: number;
    repeat?: number;
    transparent?: boolean;
    transparentIndex?: number;
    dispose?: number;
  }
  export interface Encoder {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: FrameOptions): void;
    finish(): void;
    bytes(): Uint8Array;
  }
  const gifenc: {
    GIFEncoder(): Encoder;
    quantize(rgba: Uint8Array, maxColors: number, opts?: { format?: 'rgb565' | 'rgb444' | 'rgba4444' }): Palette;
    applyPalette(rgba: Uint8Array, palette: Palette, format?: 'rgb565' | 'rgb444' | 'rgba4444'): Uint8Array;
  };
  export default gifenc;
}
