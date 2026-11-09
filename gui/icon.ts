// Menu bar icon: a ring gauge (Claude's 5-hour window) with a status dot, drawn as a PNG without dependencies.
import { deflateSync } from "node:zlib"

export type Rgb = readonly [number, number, number]

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, "ascii")
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** RGBA pixels (row-major) to a PNG file. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())])
}

/**
 * A ring filled clockwise from 12 o'clock to `fraction`, over a faint track, with an optional centre dot.
 * `size` is in pixels; draw at 2x for Retina (36 px = 18 pt menu bar icon). Edges are anti-aliased by 4x4 supersampling.
 */
export function ringIcon(size: number, fraction: number, ring: Rgb, track: Rgb, trackAlpha: number, dot?: Rgb): Buffer {
  const px = new Uint8Array(size * size * 4)
  const c = size / 2
  const outer = size / 2 - size * 0.06
  const inner = outer - size * 0.14
  const dotR = size * 0.15
  const f = Math.max(0, Math.min(1, fraction))
  const S = 4
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let ringHits = 0
      let trackHits = 0
      let dotHits = 0
      for (let sy = 0; sy < S; sy++)
        for (let sx = 0; sx < S; sx++) {
          const dx = x + (sx + 0.5) / S - c
          const dy = y + (sy + 0.5) / S - c
          const d = Math.hypot(dx, dy)
          if (dot && d <= dotR) dotHits++
          else if (d >= inner && d <= outer) {
            // Angle from 12 o'clock, clockwise, 0..1.
            const a = (Math.atan2(dx, -dy) / (2 * Math.PI) + 1) % 1
            if (a <= f) ringHits++
            else trackHits++
          }
        }
      const total = S * S
      const i = (y * size + x) * 4
      const layers: Array<[Rgb, number]> = []
      if (trackHits) layers.push([track, (trackHits / total) * trackAlpha])
      if (ringHits) layers.push([ring, ringHits / total])
      if (dotHits && dot) layers.push([dot, dotHits / total])
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (const [col, alpha] of layers) {
        // "Over" compositing in straight alpha.
        const na = alpha + a * (1 - alpha)
        if (na > 0) {
          r = (col[0] * alpha + r * a * (1 - alpha)) / na
          g = (col[1] * alpha + g * a * (1 - alpha)) / na
          b = (col[2] * alpha + b * a * (1 - alpha)) / na
        }
        a = na
      }
      px[i] = Math.round(r)
      px[i + 1] = Math.round(g)
      px[i + 2] = Math.round(b)
      px[i + 3] = Math.round(a * 255)
    }
  return encodePng(size, size, px)
}
