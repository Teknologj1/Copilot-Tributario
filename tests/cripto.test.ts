import { describe, it, expect } from 'vitest';
import {
  cifrar,
  decifrar,
  ehEnvelopeCifrado,
  gerarApiKey,
  hashApiKey,
  mascararCnpj,
} from '../src/seguranca/cripto';

describe('criptografia em repouso (secao 8)', () => {
  it('faz round-trip de um objeto', () => {
    const original = { cnpj: '12345678000195', faturamentoBruto: 150000, itens: [1, 2, 3] };
    const envelope = cifrar(original);

    expect(ehEnvelopeCifrado(envelope)).toBe(true);
    expect(decifrar(envelope)).toEqual(original);
  });

  it('nao deixa o dado legivel no envelope', () => {
    const envelope = cifrar({ cnpj: '12345678000195', segredo: 'faturamento-sigiloso' });
    const serializado = JSON.stringify(envelope);

    expect(serializado).not.toContain('faturamento-sigiloso');
    expect(serializado).not.toContain('12345678000195');
  });

  it('gera ciphertext diferente a cada chamada (IV aleatorio)', () => {
    const a = cifrar({ x: 1 });
    const b = cifrar({ x: 1 });
    expect(a.ct).not.toBe(b.ct);
  });

  it('detecta adulteracao do ciphertext', () => {
    const envelope = cifrar({ valor: 1000 });
    const bytes = Buffer.from(envelope.ct, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;

    expect(() => decifrar({ ...envelope, ct: bytes.toString('base64') })).toThrow();
  });

  it('detecta adulteracao da tag de autenticacao', () => {
    const envelope = cifrar({ valor: 1000 });
    const tag = Buffer.from(envelope.tag, 'base64');
    tag[0] = tag[0]! ^ 0xff;

    expect(() => decifrar({ ...envelope, tag: tag.toString('base64') })).toThrow();
  });

  it('rejeita envelope malformado', () => {
    expect(ehEnvelopeCifrado({ foo: 'bar' })).toBe(false);
    expect(() => decifrar({ foo: 'bar' } as never)).toThrow(/invalido/i);
  });
});

describe('API keys', () => {
  it('gera chave com hash correspondente e nao guarda a chave', () => {
    const { chave, hash } = gerarApiKey();

    expect(chave).toMatch(/^cr_/);
    expect(hash).toBe(hashApiKey(chave));
    expect(hash).not.toContain(chave);
  });

  it('chaves diferentes produzem hashes diferentes', () => {
    expect(gerarApiKey().hash).not.toBe(gerarApiKey().hash);
  });
});

describe('mascara de CNPJ para log', () => {
  it('esconde a raiz do CNPJ', () => {
    const mascarado = mascararCnpj('12345678000195');
    expect(mascarado).not.toContain('12345');
    expect(mascarado).toContain('678');
  });
});
