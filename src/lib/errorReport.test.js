import { describe, it, expect } from 'vitest';
import { formatErrorPayload } from './errorReport.js';

describe('formatErrorPayload', () => {
  it('monta [code] label, mensagem e stack', () => {
    const out = formatErrorPayload({
      code: 'ERR-0001',
      label: 'Preview',
      message: 'boom',
      stack: 'at foo\nat bar',
    });
    expect(out).toBe('[ERR-0001] Preview\nboom\n\nat foo\nat bar');
  });

  it('omite o stack quando ausente', () => {
    const out = formatErrorPayload({ code: 'ERR-0002', label: 'Chat', message: 'x' });
    expect(out).toBe('[ERR-0002] Chat\nx');
  });

  it('funciona só com mensagem (toast sem code/stack)', () => {
    const out = formatErrorPayload({ message: 'falha ao clonar' });
    expect(out).toBe('falha ao clonar');
  });
});
