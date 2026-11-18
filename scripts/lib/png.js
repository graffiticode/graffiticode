// A minimal PNG reader for the C5a gate's image evidence (scripts/c5a-gate.js):
// the camera's output is 8-bit RGB or RGBA, non-interlaced, and that is all
// this reads (anything else throws). Pure functions over Buffers.
//
//   decodePng(buffer) -> { width, height, rgba: Uint8Array }
//   imageLooks(image) -> { width, height, reddish, blue }
//     reddish: the share of pixels whose red exceeds both other channels by 8
//       or more (the View's error banner is Tailwind's red-50 on red-200: an
//       error render is ~83% reddish, a sheet 0%).
//     blue: the count of pixels whose blue exceeds red by 60 or more (a
//       rendered L0179 sheet's focused-cell outline).
//   compareImages(a, b) -> { sameSize, identical, meanDiff }
//     meanDiff: the mean absolute difference per channel (0-255) over RGB.
import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const decodePng = buffer => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let pos = 8;
  let header = null;
  const idat = [];
  while (pos + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString("latin1", pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9], interlace: data[12] };
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + length;
  }
  if (!header) throw new Error("PNG: no IHDR");
  const { width, height, depth, colorType, interlace } = header;
  if (depth !== 8 || ![2, 6].includes(colorType) || interlace !== 0) throw new Error(`PNG: unsupported (depth ${depth}, color type ${colorType}, interlace ${interlace})`);
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < height * (stride + 1)) throw new Error("PNG: truncated image data");
  const rgba = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 255;
      else if (filter === 2) line[x] = (line[x] + b) & 255;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      } else if (filter !== 0) throw new Error(`PNG: unknown filter ${filter}`);
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      rgba[o] = line[x * bpp];
      rgba[o + 1] = line[x * bpp + 1];
      rgba[o + 2] = line[x * bpp + 2];
      rgba[o + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
    prev = line;
  }
  return { width, height, rgba };
};

export const imageLooks = ({ width, height, rgba }) => {
  let reddish = 0;
  let blue = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const [r, g, b] = [rgba[i], rgba[i + 1], rgba[i + 2]];
    if (r - Math.max(g, b) >= 8) reddish++;
    if (b - r >= 60) blue++;
  }
  return { width, height, reddish: reddish / (width * height), blue };
};

export const compareImages = (a, b) => {
  if (a.width !== b.width || a.height !== b.height) return { sameSize: false, identical: false, meanDiff: null };
  let total = 0;
  let identical = true;
  for (let i = 0; i < a.rgba.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(a.rgba[i + k] - b.rgba[i + k]);
      if (d) identical = false;
      total += d;
    }
  }
  return { sameSize: true, identical, meanDiff: total / (a.width * a.height * 3) };
};
