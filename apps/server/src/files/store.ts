import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Onde o conteúdo dos arquivos fica. Os nomes são sempre o UUID gerado pelo servidor — nunca o nome
 * enviado pelo usuário — então não há como escapar do diretório.
 * Trocar por armazenamento de objetos (S3 compatível) é implementar esta interface.
 */
export interface FileStore {
  put(id: string, data: Buffer): Promise<void>;
  get(id: string): Promise<Buffer | null>;
  delete(id: string): Promise<void>;
  list(): Promise<string[]>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class DiskStore implements FileStore {
  private ready: Promise<unknown>;
  constructor(private readonly dir: string) {
    this.ready = mkdir(dir, { recursive: true });
  }
  private path(id: string) {
    if (!UUID_RE.test(id)) throw new Error('id de arquivo inválido');
    return join(this.dir, id);
  }
  async put(id: string, data: Buffer) {
    await this.ready;
    await writeFile(this.path(id), data, { flag: 'wx' });
  }
  async get(id: string) {
    try {
      return await readFile(this.path(id));
    } catch {
      return null;
    }
  }
  async delete(id: string) {
    await rm(this.path(id), { force: true });
  }
  async list() {
    await this.ready;
    return (await readdir(this.dir)).filter((n) => UUID_RE.test(n));
  }
}

export class MemoryStore implements FileStore {
  private readonly m = new Map<string, Buffer>();
  async put(id: string, data: Buffer) {
    this.m.set(id, data);
  }
  async get(id: string) {
    return this.m.get(id) ?? null;
  }
  async delete(id: string) {
    this.m.delete(id);
  }
  async list() {
    return [...this.m.keys()];
  }
}

export const createStore = (dir: string): FileStore => (dir ? new DiskStore(dir) : new MemoryStore());
