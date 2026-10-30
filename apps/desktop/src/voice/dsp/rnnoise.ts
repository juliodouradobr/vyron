/**
 * Carregador mínimo do RNNoise (Xiph, BSD-3-Clause) compilado para WebAssembly
 * (build da Shiguredo, Apache-2.0, distribuído pelo pacote MIT @sapphi-red/web-noise-suppressor).
 *
 * Instancia o .wasm diretamente — sem a "cola" do Emscripten — para funcionar igual em três lugares:
 * AudioWorklet (fora da thread da interface), OfflineAudioContext (comparação A/B) e Node (testes).
 * Tudo roda localmente: nenhum áudio sai do computador para ser processado.
 */

interface RnnoiseExports {
  memory: WebAssembly.Memory;
  __wasm_call_ctors(): void;
  emscripten_stack_init?(): void;
  rnnoise_get_frame_size(): number;
  rnnoise_create(model: number): number;
  rnnoise_destroy(st: number): void;
  rnnoise_process_frame(st: number, out: number, input: number): number;
  malloc(n: number): number;
  free(p: number): void;
}

export interface RnnoiseModule {
  readonly frameSize: number;
  exports: RnnoiseExports;
}

export async function instantiateRnnoise(bytes: BufferSource): Promise<RnnoiseModule> {
  let ex: RnnoiseExports | null = null;
  const env = {
    emscripten_memcpy_big(dest: number, src: number, num: number) {
      new Uint8Array(ex!.memory.buffer).copyWithin(dest, src, src + num);
    },
    emscripten_resize_heap(size: number) {
      const mem = ex!.memory;
      const pages = Math.ceil((size - mem.buffer.byteLength) / 65536);
      try {
        if (pages > 0) mem.grow(pages);
        return 1;
      } catch {
        return 0;
      }
    },
    __assert_fail() {
      throw new Error('rnnoise: falha de asserção interna');
    },
  };
  const { instance } = (await WebAssembly.instantiate(bytes, { env })) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
  ex = instance.exports as unknown as RnnoiseExports;
  ex.emscripten_stack_init?.();
  ex.__wasm_call_ctors();
  return { frameSize: ex.rnnoise_get_frame_size(), exports: ex };
}

/** Uma instância de supressão (estado próprio da rede neural) para um canal de áudio. */
export class Denoiser {
  readonly frameSize: number;
  private st: number;
  private inPtr: number;
  private outPtr: number;

  constructor(private readonly mod: RnnoiseModule) {
    this.frameSize = mod.frameSize;
    const ex = mod.exports;
    this.st = ex.rnnoise_create(0);
    this.inPtr = ex.malloc(this.frameSize * 4);
    this.outPtr = ex.malloc(this.frameSize * 4);
  }

  /**
   * Processa um quadro de `frameSize` amostras em [-1, 1] e escreve o resultado em `output`.
   * Retorna a probabilidade (0–1) de o quadro conter voz.
   * O RNNoise espera amplitude de PCM 16 bits, por isso a conversão de escala.
   */
  process(input: Float32Array, output: Float32Array): number {
    const ex = this.mod.exports;
    // A memória pode crescer: a visão é recriada a cada quadro.
    const heap = new Float32Array(ex.memory.buffer);
    const i0 = this.inPtr >> 2;
    const o0 = this.outPtr >> 2;
    for (let i = 0; i < this.frameSize; i++) heap[i0 + i] = input[i]! * 32768;
    const vad = ex.rnnoise_process_frame(this.st, this.outPtr, this.inPtr);
    const out = new Float32Array(ex.memory.buffer);
    for (let i = 0; i < this.frameSize; i++) output[i] = out[o0 + i]! / 32768;
    return vad;
  }

  destroy(): void {
    const ex = this.mod.exports;
    if (!this.st) return;
    ex.rnnoise_destroy(this.st);
    ex.free(this.inPtr);
    ex.free(this.outPtr);
    this.st = 0;
  }
}

/** Bytes mínimos de um módulo com uma instrução SIMD: o motor suporta wasm SIMD? */
export function supportsWasmSimd(): boolean {
  try {
    return WebAssembly.validate(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]),
    );
  } catch {
    return false;
  }
}
