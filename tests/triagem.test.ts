import { describe, it, expect } from 'vitest';
import { paraItem, formatarParaWhatsapp, type ItemTriagem } from '../src/triagem';

const hoje = new Date('2026-09-15T12:00:00Z');

function empresa(over: Record<string, unknown> = {}) {
  return {
    id: 'emp-1',
    escritorio_id: 'esc-1',
    razao_social: 'PADARIA MODELO LTDA',
    cnpj: '12345678000195',
    anexo_simples: 'I',
    uf: 'SP',
    status_decisao: 'pendente' as const,
    prazo_decisao: new Date('2026-11-30T00:00:00Z'),
    criado_em: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

describe('conversao para item de triagem', () => {
  it('calcula os dias restantes ate o prazo', () => {
    const item = paraItem(empresa(), hoje);
    expect(item.prazoDecisao).toBe('2026-11-30');
    expect(item.diasRestantes).toBe(76);
  });

  it('usa negativo para prazo vencido', () => {
    const item = paraItem(empresa({ prazo_decisao: new Date('2026-09-01T00:00:00Z') }), hoje);
    expect(item.diasRestantes).toBe(-14);
  });

  it('devolve null quando nao ha prazo', () => {
    expect(paraItem(empresa({ prazo_decisao: null }), hoje).diasRestantes).toBeNull();
  });

  it('nao se confunde com fuso na virada do dia', () => {
    const item = paraItem(
      empresa({ prazo_decisao: new Date('2026-09-15T00:00:00Z') }),
      new Date('2026-09-15T23:30:00Z'),
    );
    expect(item.diasRestantes).toBe(0);
  });
});

describe('formatacao para o WhatsApp', () => {
  const itens: ItemTriagem[] = [
    {
      empresaId: 'e1',
      razaoSocial: 'PADARIA MODELO LTDA',
      cnpj: '12345678000195',
      anexoSimples: 'I',
      uf: 'SP',
      prazoDecisao: '2026-11-30',
      diasRestantes: 76,
    },
    {
      empresaId: 'e2',
      razaoSocial: 'MERCADO CLIENTE SA',
      cnpj: '98765432000198',
      anexoSimples: null,
      uf: null,
      prazoDecisao: '2026-09-01',
      diasRestantes: -14,
    },
  ];

  it('lista as empresas com CNPJ formatado e prazo em linguagem natural', () => {
    const texto = formatarParaWhatsapp(itens);

    expect(texto).toContain('2 empresas');
    expect(texto).toContain('12.345.678/0001-95');
    expect(texto).toContain('faltam 76 dias');
    expect(texto).toContain('VENCIDO ha 14 dia(s)');
    expect(texto).toContain('Anexo I');
  });

  it('usa singular para uma empresa so', () => {
    expect(formatarParaWhatsapp([itens[0]!])).toContain('*1 empresa* pendente');
  });

  it('avisa quando a carteira esta em dia', () => {
    expect(formatarParaWhatsapp([])).toMatch(/Nenhuma empresa pendente/i);
  });

  it('trunca lista longa em vez de despejar tudo no chat', () => {
    const muitos = Array.from({ length: 25 }, (_, i) => ({ ...itens[0]!, empresaId: `e${i}` }));
    const texto = formatarParaWhatsapp(muitos, 10);

    expect(texto).toContain('25 empresas');
    expect(texto).toContain('e mais 15');
    expect(texto.split('\n\n').length).toBeLessThan(16);
  });

  it('descreve hoje e amanha por extenso', () => {
    expect(formatarParaWhatsapp([{ ...itens[0]!, diasRestantes: 0 }])).toContain('vence HOJE');
    expect(formatarParaWhatsapp([{ ...itens[0]!, diasRestantes: 1 }])).toContain('vence amanha');
  });

  it('ensina o proximo comando', () => {
    expect(formatarParaWhatsapp(itens)).toContain('simular [CNPJ]');
  });
});
