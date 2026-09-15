import { describe, it, expect } from 'vitest';
import { cnpjValido, formatarCnpj, normalizarCnpj } from '../src/comum/cnpj';

describe('CNPJ', () => {
  it('valida digitos verificadores corretos', () => {
    expect(cnpjValido('12345678000195')).toBe(true);
    expect(cnpjValido('98765432000198')).toBe(true);
  });

  it('aceita CNPJ formatado', () => {
    expect(cnpjValido('12.345.678/0001-95')).toBe(true);
  });

  it('rejeita digito verificador errado', () => {
    expect(cnpjValido('12345678000190')).toBe(false);
    expect(cnpjValido('12345678000194')).toBe(false);
  });

  it('rejeita tamanho invalido e sequencias repetidas', () => {
    expect(cnpjValido('123')).toBe(false);
    expect(cnpjValido('')).toBe(false);
    // Passam no modulo 11, mas nao existem como CNPJ.
    expect(cnpjValido('00000000000000')).toBe(false);
    expect(cnpjValido('11111111111111')).toBe(false);
  });

  it('normaliza e formata', () => {
    expect(normalizarCnpj('12.345.678/0001-95')).toBe('12345678000195');
    expect(formatarCnpj('12345678000195')).toBe('12.345.678/0001-95');
  });
});
