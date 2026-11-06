// Minimal baseline JPEG encoder (JFIF, 8-bit grayscale, standard Annex K tables) for the synthetic
// dataset (M2-01 needs a real JPEG in fixtures/dataset). Deterministic: same pixels, same bytes.
//
//   encodeGrayJpeg(pixels: Uint8Array /* width*height, row-major */, width, height, quality = 75)

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

// ITU T.81 Annex K.1, luminance, natural (row-major) order.
const STD_LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
  92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

// Annex K.3 luminance Huffman tables: code counts per length 1..16, then the symbols.
const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

/** Canonical Huffman codes: symbol → [code, length]. */
function huffmanTable(bits, vals) {
  const table = new Map();
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) table.set(vals[k++], [code++, len]);
    code <<= 1;
  }
  return table;
}

class BitWriter {
  bytes = [];
  acc = 0;
  n = 0;
  write(code, len) {
    for (let i = len - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((code >> i) & 1);
      if (++this.n === 8) {
        this.bytes.push(this.acc);
        if (this.acc === 0xff) this.bytes.push(0x00); // byte stuffing
        this.acc = 0;
        this.n = 0;
      }
    }
  }
  flush() {
    if (this.n > 0) this.write((1 << (8 - this.n)) - 1, 8 - this.n); // pad with 1-bits
  }
}

const COS = Array.from({ length: 64 }, (_, i) => {
  const x = i >> 3;
  const u = i & 7;
  return Math.cos(((2 * x + 1) * u * Math.PI) / 16);
});
const C = (u) => (u === 0 ? Math.SQRT1_2 : 1);

function fdct(block) {
  const out = new Float64Array(64);
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) sum += block[y * 8 + x] * COS[x * 8 + u] * COS[y * 8 + v];
      }
      out[v * 8 + u] = 0.25 * C(u) * C(v) * sum;
    }
  }
  return out;
}

function category(v) {
  let a = Math.abs(v);
  let s = 0;
  while (a > 0) {
    s++;
    a >>= 1;
  }
  return s;
}

const bitsOf = (v, s) => (v < 0 ? v + (1 << s) - 1 : v);

const u16 = (n) => [(n >> 8) & 0xff, n & 0xff];
const segment = (marker, payload) => [0xff, marker, ...u16(payload.length + 2), ...payload];

export function encodeGrayJpeg(pixels, width, height, quality = 75) {
  const scale = quality < 50 ? Math.floor(5000 / quality) : 200 - 2 * quality;
  const q = STD_LUMA_Q.map((v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
  const dc = huffmanTable(DC_BITS, DC_VALS);
  const ac = huffmanTable(AC_BITS, AC_VALS);
  const w = new BitWriter();
  let prevDc = 0;
  const block = new Float64Array(64);
  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      for (let y = 0; y < 8; y++) {
        const sy = Math.min(by + y, height - 1);
        for (let x = 0; x < 8; x++) {
          block[y * 8 + x] = pixels[sy * width + Math.min(bx + x, width - 1)] - 128;
        }
      }
      const coef = fdct(block);
      const zz = ZIGZAG.map((i) => Math.round(coef[i] / q[i]));
      const diff = zz[0] - prevDc;
      prevDc = zz[0];
      const s = category(diff);
      const [dcCode, dcLen] = dc.get(s);
      w.write(dcCode, dcLen);
      if (s) w.write(bitsOf(diff, s), s);
      let run = 0;
      for (let k = 1; k < 64; k++) {
        const v = zz[k];
        if (v === 0) {
          run++;
          continue;
        }
        while (run > 15) {
          const [c, l] = ac.get(0xf0);
          w.write(c, l);
          run -= 16;
        }
        const size = category(v);
        const [c, l] = ac.get((run << 4) | size);
        w.write(c, l);
        w.write(bitsOf(v, size), size);
        run = 0;
      }
      if (run > 0) {
        const [c, l] = ac.get(0x00);
        w.write(c, l);
      }
    }
  }
  w.flush();
  return Buffer.from([
    0xff,
    0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, ...u16(1), ...u16(1), 0, 0]),
    ...segment(0xdb, [0x00, ...ZIGZAG.map((i) => q[i])]),
    ...segment(0xc0, [8, ...u16(height), ...u16(width), 1, 1, 0x11, 0]),
    ...segment(0xc4, [0x00, ...DC_BITS, ...DC_VALS]),
    ...segment(0xc4, [0x10, ...AC_BITS, ...AC_VALS]),
    ...segment(0xda, [1, 1, 0x00, 0, 63, 0]),
    ...w.bytes,
    0xff,
    0xd9,
  ]);
}
