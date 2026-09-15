import { describe, it, expect } from 'vitest';
import {
  interpretar,
  interpretarAnexo,
  interpretarValor,
  podeTransitar,
  resolverPendencia,
  proximaPendencia,
} from '../src/intake/maquinaEstados';

describe('interpretacao de comandos', () => {
  it('reconhece simular com CNPJ em qualquer formatacao', () => {
    expect(interpretar('simular 12.345.678/0001-95')).toEqual({
      tipo: 'simular',
      cnpj: '12345678000195',
    });
    expect(interpretar('simular 12345678000195')).toEqual({
      tipo: 'simular',
      cnpj: '12345678000195',
    });
  });

  it('reconhece simular sem CNPJ', () => {
    expect(interpretar('simular')).toEqual({ tipo: 'simular' });
  });

  it('reconhece triagem, ajuda e cancelamento', () => {
    expect(interpretar('pendentes').tipo).toBe('pendentes');
    expect(interpretar('carteira').tipo).toBe('pendentes');
    expect(interpretar('ajuda').tipo).toBe('ajuda');
    expect(interpretar('oi').tipo).toBe('ajuda');
    expect(interpretar('reforma').tipo).toBe('ajuda');
    expect(interpretar('cancelar').tipo).toBe('cancelar');
  });

  it('ignora acentuacao e caixa', () => {
    expect(interpretar('PENDÊNCIAS').tipo).toBe('pendentes');
    expect(interpretar('Não').tipo).toBe('nao');
    expect(interpretar('SIM').tipo).toBe('sim');
  });

  it('trata texto livre como resposta', () => {
    expect(interpretar('anexo 3')).toEqual({ tipo: 'resposta', texto: 'anexo 3' });
  });
});

describe('interpretacao de anexo do Simples', () => {
  it('aceita romano, arabe e com prefixo', () => {
    expect(interpretarAnexo('III')).toBe('III');
    expect(interpretarAnexo('3')).toBe('III');
    expect(interpretarAnexo('anexo 3')).toBe('III');
    expect(interpretarAnexo('Anexo I')).toBe('I');
    expect(interpretarAnexo('v')).toBe('V');
  });

  it('recusa valor fora da faixa em vez de chutar', () => {
    expect(interpretarAnexo('9')).toBeNull();
    expect(interpretarAnexo('VIII')).toBeNull();
    expect(interpretarAnexo('sei la')).toBeNull();
  });
});

describe('interpretacao de valores monetarios', () => {
  it('le formato brasileiro', () => {
    expect(interpretarValor('120.000,00')).toBe(120000);
    expect(interpretarValor('R$ 1.500.000,50')).toBe(1500000.5);
    expect(interpretarValor('90000')).toBe(90000);
  });

  it('entende "mil" e "milhao"', () => {
    expect(interpretarValor('120 mil')).toBe(120000);
    expect(interpretarValor('1,2 milhao')).toBe(1200000);
    expect(interpretarValor('R$ 2 milhoes')).toBe(2000000);
  });

  it('devolve null quando nao da para ler com seguranca', () => {
    expect(interpretarValor('nao sei direito')).toBeNull();
    expect(interpretarValor('')).toBeNull();
  });
});

describe('transicoes de estado', () => {
  it('permite o caminho feliz', () => {
    expect(podeTransitar('ocioso', 'processando')).toBe(true);
    expect(podeTransitar('aguardando_dados', 'confirmando_campos')).toBe(true);
    expect(podeTransitar('confirmando_campos', 'processando')).toBe(true);
    expect(podeTransitar('processando', 'entregue')).toBe(true);
    expect(podeTransitar('entregue', 'ocioso')).toBe(true);
  });

  it('bloqueia salto direto de ocioso para entregue', () => {
    expect(podeTransitar('ocioso', 'entregue')).toBe(false);
  });

  it('permite permanecer no mesmo estado', () => {
    expect(podeTransitar('confirmando_campos', 'confirmando_campos')).toBe(true);
  });
});

describe('fila de pendencias', () => {
  const contexto = {
    pendencias: [
      { campo: 'anexoSimples', pergunta: 'Qual anexo?', obrigatorio: true },
      { campo: 'folhaSalarios12m', pergunta: 'Qual folha?', obrigatorio: false },
    ],
  };

  it('devolve a proxima pergunta na ordem', () => {
    expect(proximaPendencia(contexto)?.campo).toBe('anexoSimples');
  });

  it('remove a pendencia respondida', () => {
    const atualizado = resolverPendencia(contexto, 'anexoSimples');
    expect(atualizado.pendencias).toHaveLength(1);
    expect(proximaPendencia(atualizado)?.campo).toBe('folhaSalarios12m');
  });

  it('devolve null quando nao ha mais pendencias', () => {
    expect(proximaPendencia({ pendencias: [] })).toBeNull();
    expect(proximaPendencia({})).toBeNull();
  });
});
