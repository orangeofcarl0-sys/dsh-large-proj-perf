// 多帧 zstd 解码器（复刻 dsh 的逐帧语义）
import { zstdDecompressSync, createZstdDecompress } from 'node:zlib'

// 逐帧解压：扫描 zstd frame 边界，每帧独立 zstdDecompressSync
export function decodeAllFrames(buf) {
  // zstd frame magic = 0xFD2FB528 (little-endian: 28 B5 2F FD)
  const MAGIC = [0x28, 0xB5, 0x2F, 0xFD]
  const chunks = []
  let start = -1
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      if (start !== -1) chunks.push(buf.subarray(start, i))
      start = i
    }
  }
  if (start !== -1) chunks.push(buf.subarray(start))
  return Buffer.concat(chunks.map((c) => zstdDecompressSync(c)))
}

export function countFrames(buf) {
  let n = 0
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) n++
  }
  return n
}
