/**
 * FLATTENED interchange writers. Both write the merged composite only – no layers, masks or editable text.
 * They must be labelled "flattened" wherever they are offered; they are NOT layered PSD/TIFF support.
 */
export interface FlatImage { width: number; height: number; rgba: Uint8Array; ppi: number }

const MAX_TIFF_BYTES = 4 * 1024 ** 3 - 1024;

/** Baseline TIFF 6.0, little-endian, RGB + unassociated alpha, 8 bit, uncompressed, single strip. */
export function writeFlatTiff(img: FlatImage): Uint8Array {
  const { width: w, height: h, rgba } = img;
  if (rgba.length !== w * h * 4) throw new RangeError('rgba size mismatch');
  const dataLen = w * h * 4;
  const entries = 13;
  const ifdOff = 8, ifdLen = 2 + entries * 12 + 4;
  const bpsOff = ifdOff + ifdLen;       // 4 × u16
  const xresOff = bpsOff + 8;           // rational
  const yresOff = xresOff + 8;          // rational
  const dataOff = yresOff + 8;
  if (dataOff + dataLen > MAX_TIFF_BYTES) throw new RangeError('image too large for classic TIFF (4 GiB)');
  const out = new Uint8Array(dataOff + dataLen);
  const dv = new DataView(out.buffer);
  out[0] = 0x49; out[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, ifdOff, true);
  dv.setUint16(ifdOff, entries, true);
  let p = ifdOff + 2;
  const tag = (id: number, type: number, count: number, value: number) => {
    dv.setUint16(p, id, true); dv.setUint16(p + 2, type, true); dv.setUint32(p + 4, count, true);
    if (type === 3 && count === 1) dv.setUint16(p + 8, value, true); else dv.setUint32(p + 8, value, true);
    p += 12;
  };
  const SHORT = 3, LONG = 4, RATIONAL = 5;
  tag(256, LONG, 1, w); tag(257, LONG, 1, h); tag(258, SHORT, 4, bpsOff); tag(259, SHORT, 1, 1); tag(262, SHORT, 1, 2);
  tag(273, LONG, 1, dataOff); tag(277, SHORT, 1, 4); tag(278, LONG, 1, h); tag(279, LONG, 1, dataLen);
  tag(282, RATIONAL, 1, xresOff); tag(283, RATIONAL, 1, yresOff); tag(296, SHORT, 1, 2); tag(338, SHORT, 1, 2);
  dv.setUint32(p, 0, true); // no next IFD
  for (let i = 0; i < 4; i++) dv.setUint16(bpsOff + i * 2, 8, true);
  const ppi = Math.max(1, Math.round(img.ppi));
  dv.setUint32(xresOff, ppi, true); dv.setUint32(xresOff + 4, 1, true); dv.setUint32(yresOff, ppi, true); dv.setUint32(yresOff + 4, 1, true);
  out.set(rgba, dataOff);
  return out;
}

/** Photoshop file, version 1, RGB 8-bit, merged image only (raw), channel 4 = transparency. Max 30 000 px per side. */
export function writeFlatPsd(img: FlatImage): Uint8Array {
  const { width: w, height: h, rgba } = img;
  if (w > 30000 || h > 30000) throw new RangeError('flattened PSD is limited to 30000 px per side (PSB not implemented)');
  if (rgba.length !== w * h * 4) throw new RangeError('rgba size mismatch');
  const n = w * h;
  const headLen = 26 + 4 + 4 + 4 + 2;
  const out = new Uint8Array(headLen + n * 4);
  const dv = new DataView(out.buffer);
  out.set([0x38, 0x42, 0x50, 0x53], 0); // "8BPS"
  dv.setUint16(4, 1); // version
  dv.setUint16(12, 4); // channels
  dv.setUint32(14, h); dv.setUint32(18, w); dv.setUint16(22, 8); dv.setUint16(24, 3); // RGB
  // colour mode data length (0), image resources length (0), layer & mask info length (0)
  dv.setUint32(26, 0); dv.setUint32(30, 0); dv.setUint32(34, 0);
  dv.setUint16(38, 0); // compression: raw
  let o = headLen;
  for (let c = 0; c < 4; c++) for (let i = 0; i < n; i++) out[o++] = rgba[i * 4 + c];
  return out;
}
