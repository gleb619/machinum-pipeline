/**
 * Drop-in replacement for `tiktoken` inside the single-file binary.
 *
 * `tiktoken` loads a WebAssembly module; Bun's bundler mis-compiles it ("Out of bounds memory
 * access" / "Missing tiktoken_bg.wasm"), so the token counter traps in the binary. `gpt-tokenizer`
 * is a pure JavaScript port of the same `cl100k_base` BPE and produces the same token counts.
 *
 * Wired up by `scripts/build-bin.ts` — the npm package keeps using the real `tiktoken`.
 */
import { encode } from 'gpt-tokenizer/encoding/cl100k_base'

interface Encoder {
  encode(text: string): number[]
  free(): void
}

const SUPPORTED = new Set(['cl100k_base', 'p50k_base', 'r50_base', 'o200k_base'])

/** Mirrors `tiktoken`'s `get_encoding(name)`. */
export function get_encoding(name: string): Encoder {
  if (!SUPPORTED.has(name)) {
    throw new Error(`Unsupported encoding: ${name}`)
  }
  return {
    encode: (text: string) => encode(text),
    free: () => {},
  }
}
