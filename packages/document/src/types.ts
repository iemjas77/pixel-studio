import type { BlendMode, TileStore } from '@ps/raster';

export const SCHEMA_VERSION = 1;

export interface Lock { pixels: boolean; position: boolean; all: boolean }
export interface MaskState { tiles: TileStore; enabled: boolean; linked: boolean }

export interface TextData {
  text: string;
  fontFamily: string;
  fontSize: number;       // px at document resolution
  fontWeight: number;     // 100..900
  italic: boolean;
  color: [number, number, number, number]; // RGBA 0..255
  align: 'left' | 'center' | 'right';
  lineHeight: number;     // multiplier
  tracking: number;       // px letter spacing
  /** Area text width in px; null = point text. */
  boxWidth: number | null;
}

interface LayerBase {
  id: string;
  name: string;
  visible: boolean;
  lock: Lock;
  opacity: number;
  blendMode: BlendMode;
  offset: { x: number; y: number };
  mask: MaskState | null;
  /** Unknown manifest properties from newer minor versions; re-emitted verbatim. */
  unknown?: Record<string, unknown>;
}
export interface RasterLayer extends LayerBase { kind: 'raster'; pixels: TileStore }
export interface TextLayer extends LayerBase { kind: 'text'; text: TextData }
export interface GroupLayer extends LayerBase { kind: 'group'; children: Layer[]; expanded: boolean }
/** A layer of an unknown kind (newer writer). Preserved verbatim, rendered as nothing. */
export interface OpaqueLayer extends LayerBase { kind: 'opaque'; originalKind: string; raw: Record<string, unknown> }
export type Layer = RasterLayer | TextLayer | GroupLayer | OpaqueLayer;
export type LayerKind = Layer['kind'];

export type Selection = { kind: 'rect'; x: number; y: number; w: number; h: number };
export interface Guide { orientation: 'h' | 'v'; position: number }

export interface Canvas {
  width: number;
  height: number;
  resolutionPpi: number;
  mode: 'RGB';
  bitDepth: 8;
  /** Space in which layers are blended: encoded sRGB values (default) or linear light. Format ≥ 1.1. */
  blendSpace?: 'srgb' | 'linear';
  /** Colour profile tag. Pixel Studio M1–M5 does not manage colour: sRGB is assumed. */
  profile: { name: string; assumed: boolean };
}

export interface PsDocument {
  schemaVersion: number;
  id: string;
  name: string;
  canvas: Canvas;
  /** Painter's order: index 0 = bottom. */
  layers: Layer[];
  selection: Selection | null;
  guides: Guide[];
  unknown?: Record<string, unknown>;
}

export const MAX_CANVAS_SIDE = 32768;
export const MAX_CANVAS_PIXELS = 400_000_000;
export const MAX_LAYERS = 4096;
export const MAX_GROUP_DEPTH = 64;
