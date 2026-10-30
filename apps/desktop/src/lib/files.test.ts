import { describe, expect, it } from 'vitest';
import { formatBytes } from './files';

describe('formatBytes', () => {
  it('formata tamanhos de arquivo', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(200 * 1024)).toBe('200 KB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10.0 MB');
  });
});
