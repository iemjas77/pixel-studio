import { TileStore, TileWriter } from '@ps/raster';
import { MAX_CANVAS_SIDE, flattenDocument, type PixelResolver, type PsDocument } from '@ps/document';

export const IMPORT_MAX_PIXELS = 64_000_000;
export const EXPORT_MAX_PIXELS = 100_000_000;

export class UserError extends Error {
  constructor(message: string) { super(message); this.name = 'UserError'; }
}

export interface DecodedImage { width: number; height: number; store: TileStore }

/**
 * Decode PNG/JPEG/WebP/GIF/BMP via Chromium. Embedded colour profiles are converted to sRGB by the
 * browser decoder (Pixel Studio itself does no colour management in this preview).
 */
export async function decodeImage(bytes: Uint8Array): Promise<DecodedImage> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
  } catch {
    throw new UserError('This file is not a supported image, or it is corrupt. Supported: PNG, JPEG, WebP, GIF, BMP, and .pstudio documents.');
  }
  try {
    const { width, height } = bmp;
    if (width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE || width * height > IMPORT_MAX_PIXELS) {
      throw new UserError(`Image is ${width}×${height}. The preview build imports images up to ${IMPORT_MAX_PIXELS / 1e6} megapixels.`);
    }
    const c = new OffscreenCanvas(width, height);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, width, height);
    const store = new TileStore('RGBA8');
    const wr = new TileWriter(store);
    store.writeRegion(wr, 0, 0, width, height, new Uint8Array(img.data.buffer));
    wr.finish();
    return { width, height, store };
  } finally { bmp.close(); }
}

export type ExportFormat = 'png' | 'jpg' | 'webp';
const MIME: Record<ExportFormat, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/** Flatten the visible composite and encode it. This is a FLATTENED export (layers are not preserved). */
export async function exportFlattened(doc: PsDocument, fmt: ExportFormat, quality: number, resolve: PixelResolver): Promise<Uint8Array> {
  const { width, height } = doc.canvas;
  if (width * height > EXPORT_MAX_PIXELS) throw new UserError(`Export is limited to ${EXPORT_MAX_PIXELS / 1e6} megapixels in the preview build.`);
  const rgba = flattenDocument(doc, resolve);
  const src = new OffscreenCanvas(width, height);
  src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer), width, height), 0, 0);
  let out = src;
  if (fmt === 'jpg') { // JPEG has no alpha: composite over white
    out = new OffscreenCanvas(width, height);
    const g = out.getContext('2d')!;
    g.fillStyle = '#fff'; g.fillRect(0, 0, width, height);
    g.drawImage(src, 0, 0);
  }
  const blob = await out.convertToBlob({ type: MIME[fmt], quality: fmt === 'png' ? undefined : quality });
  if (blob.type !== MIME[fmt]) throw new UserError(`This build cannot encode ${fmt.toUpperCase()}.`);
  return new Uint8Array(await blob.arrayBuffer());
}

export function sniffKind(bytes: Uint8Array): 'pstudio' | 'image' {
  const m = [0x50, 0x53, 0x54, 0x55, 0x44, 0x49, 0x4f];
  return m.every((v, i) => bytes[i] === v) ? 'pstudio' : 'image';
}
