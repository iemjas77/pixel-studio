export * from '@ps/document';
import { isBlendMode, type BlendMode } from '@ps/raster';
export const isBlendModeValue = (v: unknown): v is BlendMode => isBlendMode(v);
