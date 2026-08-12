import sharp from 'sharp';
import path from 'node:path';
import { ffmpeg } from './ffmpeg';

const SIZE = 32; // DCT input edge
const HASH_EDGE = 8; // low-frequency block we keep -> 64 bits

/** Precomputed DCT-II basis: cos((2x+1) * u * pi / 2N). */
const COS = (() => {
  const table: number[][] = [];
  for (let u = 0; u < SIZE; u++) {
    table[u] = [];
    for (let x = 0; x < SIZE; x++) {
      table[u][x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * SIZE));
    }
  }
  return table;
})();

function dct2d(pixels: number[][]): number[][] {
  // Separable transform: rows first, then columns.
  const rows: number[][] = [];
  for (let y = 0; y < SIZE; y++) {
    rows[y] = [];
    for (let u = 0; u < SIZE; u++) {
      let sum = 0;
      for (let x = 0; x < SIZE; x++) sum += pixels[y][x] * COS[u][x];
      rows[y][u] = sum;
    }
  }

  const out: number[][] = [];
  for (let v = 0; v < SIZE; v++) {
    out[v] = [];
    for (let u = 0; u < SIZE; u++) {
      let sum = 0;
      for (let y = 0; y < SIZE; y++) sum += rows[y][u] * COS[v][y];
      out[v][u] = sum;
    }
  }
  return out;
}

/** 64-bit perceptual hash of a still image, hex encoded. */
export async function imagePhash(file: string): Promise<string> {
  const raw = await sharp(file)
    .greyscale()
    .resize(SIZE, SIZE, { fit: 'fill' })
    .raw()
    .toBuffer();

  const pixels: number[][] = [];
  for (let y = 0; y < SIZE; y++) {
    pixels[y] = [];
    for (let x = 0; x < SIZE; x++) pixels[y][x] = raw[y * SIZE + x];
  }

  const coeffs = dct2d(pixels);

  // Drop the DC term: it only encodes overall brightness.
  const block: number[] = [];
  for (let v = 0; v < HASH_EDGE; v++) {
    for (let u = 0; u < HASH_EDGE; u++) {
      if (v === 0 && u === 0) continue;
      block.push(coeffs[v][u]);
    }
  }

  const sorted = [...block].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  let bits = '';
  bits += '0'; // placeholder for the dropped DC slot, keeps the hash 64 bits
  for (const c of block) bits += c > median ? '1' : '0';

  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/**
 * Hash of a frame sampled from the middle of the video. The midpoint avoids
 * intros and end cards, which are exactly the parts a reposter changes.
 */
export async function videoPhash(
  file: string,
  durationSeconds: number,
  tmpDir: string,
): Promise<string> {
  const frame = path.join(tmpDir, 'phash-frame.png');
  const at = Math.max(0, durationSeconds / 2);

  await ffmpeg([
    '-y',
    '-ss', at.toFixed(2),
    '-i', file,
    '-frames:v', '1',
    '-q:v', '2',
    frame,
  ]);

  return imagePhash(frame);
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;

  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    let xor = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (xor) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

/** Below this two clips are the same content, re-encoded or lightly cropped. */
export const DUPLICATE_THRESHOLD = 10;
