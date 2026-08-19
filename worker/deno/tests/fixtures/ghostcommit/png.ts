/**
 * Minimal, dependency-free PNG encoder + a 5×7 bitmap font, used to build the
 * benign GhostCommit canary image fixtures (Issue #3390).
 *
 * The encoder produces a valid truecolour (RGB, 8-bit) PNG whose pixels carry
 * the overlaid injection text, and embeds the exact instruction payload as a
 * `tEXt` chunk so the committed bytes can be verified deterministically without
 * decoding the pixel data. It is only ever used to synthesise *benign* test
 * fixtures — never to read untrusted images.
 *
 * KISS: no external dependency, only the platform `CompressionStream` (zlib
 * "deflate") for the IDAT payload, plus a table-driven CRC-32.
 *
 * Australian English used throughout (behaviour, colour, organisation, etc.).
 */

// ---------------------------------------------------------------------------
// CRC-32 (IEEE, the PNG / zlib polynomial)
// ---------------------------------------------------------------------------

const CRC_TABLE: number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 of a byte range, per the PNG specification. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const idx = (c ^ (bytes[i] ?? 0)) & 0xff;
    c = (CRC_TABLE[idx] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Chunk / stream helpers
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function u32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Build a length-prefixed, CRC-checked PNG chunk. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = concat([typeBytes, data]);
  return concat([u32(data.length), body, u32(crc32(body))]);
}

/** zlib-compress (RFC 1950 / PNG IDAT format) via the platform CompressionStream. */
async function zlibCompress(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  // Copy into a standalone ArrayBuffer to satisfy the BufferSource typing.
  void writer.write(new Uint8Array(data));
  void writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

export interface PngTextChunk {
  keyword: string;
  text: string;
}

export interface EncodePngOptions {
  width: number;
  height: number;
  /** RGB pixels, `width * height * 3` bytes, row-major, top-to-bottom. */
  pixels: Uint8Array;
  /** Optional `tEXt` metadata chunks written before IDAT. */
  text?: PngTextChunk[];
}

/** Encode an 8-bit truecolour PNG. */
export async function encodePng(
  options: EncodePngOptions,
): Promise<Uint8Array> {
  const { width, height, pixels } = options;
  const expected = width * height * 3;
  if (pixels.length !== expected) {
    throw new Error(
      `encodePng: pixels length ${pixels.length} !== expected ${expected}`,
    );
  }

  // IHDR
  const ihdr = concat([
    u32(width),
    u32(height),
    new Uint8Array([8, 2, 0, 0, 0]), // bit depth 8, colour type 2 (RGB)
  ]);

  // Raw scanlines: each row prefixed with filter byte 0 (None).
  const stride = width * 3;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const src = y * stride;
    const dst = y * (stride + 1);
    raw[dst] = 0;
    raw.set(pixels.subarray(src, src + stride), dst + 1);
  }
  const idat = await zlibCompress(raw);

  const chunks: Uint8Array[] = [PNG_SIGNATURE, chunk("IHDR", ihdr)];
  for (const t of options.text ?? []) {
    const data = concat([
      new TextEncoder().encode(t.keyword),
      new Uint8Array([0]),
      // tEXt is Latin-1; our payloads are ASCII so UTF-8 == Latin-1 here.
      new TextEncoder().encode(t.text),
    ]);
    chunks.push(chunk("tEXt", data));
  }
  chunks.push(chunk("IDAT", idat));
  chunks.push(chunk("IEND", new Uint8Array(0)));
  return concat(chunks);
}

// ---------------------------------------------------------------------------
// tEXt reader (synchronous — used by the fixture self-check)
// ---------------------------------------------------------------------------

/** True when the bytes start with the 8-byte PNG signature. */
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

/** Read every `tEXt` chunk as a keyword → text map. */
export function readTextChunks(bytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  if (!isPng(bytes)) return out;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = PNG_SIGNATURE.length;
  const decoder = new TextDecoder();
  while (pos + 8 <= bytes.length) {
    const length = view.getUint32(pos);
    const type = decoder.decode(bytes.subarray(pos + 4, pos + 8));
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) break;
    if (type === "tEXt") {
      const data = bytes.subarray(dataStart, dataEnd);
      const nul = data.indexOf(0);
      if (nul >= 0) {
        const keyword = decoder.decode(data.subarray(0, nul));
        const text = decoder.decode(data.subarray(nul + 1));
        out.set(keyword, text);
      }
    }
    if (type === "IEND") break;
    pos = dataEnd + 4; // skip CRC
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5×7 bitmap font (row-major, bit 4 = leftmost pixel) for [A-Z 0-9 space _]
// ---------------------------------------------------------------------------

const FONT: Record<string, number[]> = {
  " ": [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  "_": [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f],
  "A": [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  "B": [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  "C": [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  "D": [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  "E": [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  "F": [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  "G": [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  "H": [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  "I": [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "J": [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  "K": [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  "L": [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  "M": [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  "N": [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  "O": [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  "P": [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  "Q": [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  "R": [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  "S": [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  "T": [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  "U": [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  "V": [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  "W": [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a],
  "X": [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  "Y": [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  "Z": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
  "3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
};

const GLYPH_W = 5;
const GLYPH_H = 7;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface RenderOptions {
  /** Foreground (text) colour. */
  fg: Rgb;
  /** Background colour. */
  bg: Rgb;
  /** Pixel scale of each glyph dot. */
  scale: number;
  /** Maximum characters per rendered line before wrapping. */
  charsPerLine: number;
}

export interface RenderedImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** Wrap on spaces, then hard-wrap any word longer than the line width. */
function wrapText(text: string, charsPerLine: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  const push = () => {
    if (current.length > 0) lines.push(current);
    current = "";
  };
  for (const word of words) {
    let w = word;
    while (w.length > charsPerLine) {
      push();
      lines.push(w.slice(0, charsPerLine));
      w = w.slice(charsPerLine);
    }
    const candidate = current.length === 0 ? w : `${current} ${w}`;
    if (candidate.length > charsPerLine) {
      push();
      current = w;
    } else {
      current = candidate;
    }
  }
  push();
  return lines.length > 0 ? lines : [""];
}

/**
 * Render uppercase text (characters outside the font render as blanks) into an
 * RGB pixel buffer with the given colours. Returns the buffer plus dimensions,
 * ready for {@link encodePng}.
 */
export function renderText(
  text: string,
  options: RenderOptions,
): RenderedImage {
  const { fg, bg, scale, charsPerLine } = options;
  const lines = wrapText(text.toUpperCase(), charsPerLine);
  const margin = 2 * scale;
  const cellW = (GLYPH_W + 1) * scale; // +1 column of inter-glyph spacing
  const cellH = (GLYPH_H + 1) * scale; // +1 row of inter-line spacing

  const width = margin * 2 + charsPerLine * cellW;
  const height = margin * 2 + lines.length * cellH;
  const pixels = new Uint8Array(width * height * 3);

  // Fill background.
  for (let i = 0; i < width * height; i++) {
    pixels[i * 3] = bg.r;
    pixels[i * 3 + 1] = bg.g;
    pixels[i * 3 + 2] = bg.b;
  }

  const plot = (px: number, py: number) => {
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        const x = px + dx;
        const y = py + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const idx = (y * width + x) * 3;
        pixels[idx] = fg.r;
        pixels[idx + 1] = fg.g;
        pixels[idx + 2] = fg.b;
      }
    }
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li] ?? "";
    const baseY = margin + li * cellH;
    for (let ci = 0; ci < line.length; ci++) {
      const glyph = FONT[line[ci] ?? " "] ?? FONT[" "] ?? [];
      const baseX = margin + ci * cellW;
      for (let row = 0; row < GLYPH_H; row++) {
        const bits = glyph[row] ?? 0;
        for (let col = 0; col < GLYPH_W; col++) {
          if ((bits >> (GLYPH_W - 1 - col)) & 1) {
            plot(baseX + col * scale, baseY + row * scale);
          }
        }
      }
    }
  }

  return { width, height, pixels };
}
