import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { gerarLaudo } from '../src/laudo';
import { montarResumo, AVISO_RESPONSABILIDADE } from '../src/laudo/texto';
import { simular } from '../src/simulacao/motor';
import type { ParametrosSimulacao } from '../src/simulacao/interface';

const params: ParametrosSimulacao = {
  cnpj: '12345678000195',
  anexoSimples: 'I',
  faturamentoBrutoAnual: 900000,
  composicaoReceita: { percentualB2B: 70, percentualB2C: 30 },
  ano: 2026,
  comprasComCredito: 400000,
  uf: 'SP',
};

const empresa = {
  razaoSocial: 'PADARIA MODELO LTDA',
  cnpj: '12345678000195',
  anexoSimples: 'I',
  uf: 'SP',
};

describe('geracao do laudo em PDF', () => {
  it('gera um PDF valido com mais de uma pagina', async () => {
    const resultado = await simular(params);
    const pdf = await gerarLaudo(resultado, empresa);

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(2000);

    // A memoria de calculo abre uma pagina propria.
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
    expect(doc.getTitle()).toContain('PADARIA MODELO');
  });

  it('nao quebra com razao social longa nem com muitos anos', async () => {
    const resultado = await simular(params, {
      anos: [2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033],
    });
    const pdf = await gerarLaudo(resultado, {
      ...empresa,
      razaoSocial: 'INDUSTRIA E COMERCIO DE PRODUTOS ALIMENTICIOS DO VALE DO PARAIBA LTDA ME',
    });

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('funciona sem anexo e sem UF', async () => {
    const resultado = await simular(params);
    const pdf = await gerarLaudo(resultado, {
      razaoSocial: 'EMPRESA SEM DADOS',
      cnpj: '12345678000195',
    });

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('resumo em linguagem simples', () => {
  it('traz titulo, paragrafos e resumo de WhatsApp', async () => {
    const resultado = await simular(params);
    const resumo = montarResumo(resultado, empresa);

    expect(resumo.titulo).toMatch(/dentro do DAS|fora do DAS/i);
    // A secao 5.4 pede 2-3 paragrafos.
    expect(resumo.paragrafos.length).toBeGreaterThanOrEqual(2);
    expect(resumo.paragrafos.length).toBeLessThanOrEqual(4);
    expect(resumo.resumoWhatsapp).toContain('PADARIA MODELO LTDA');
    expect(resumo.resumoWhatsapp).toContain('12.345.678/0001-95');
  });

  it('explica o mecanismo do credito quando a clientela e B2B', async () => {
    const resultado = await simular(params);
    const resumo = montarResumo(resultado, empresa);
    expect(resumo.paragrafos.join(' ')).toMatch(/credito/i);
  });

  it('menciona a confianca da simulacao no resumo do WhatsApp', async () => {
    const resultado = await simular(params);
    const resumo = montarResumo(resultado, empresa);
    expect(resumo.resumoWhatsapp).toMatch(/baixa/);
  });
});

describe('avisos obrigatorios (secao 8)', () => {
  it('o aviso de responsabilidade tecnica fala de contador responsavel', () => {
    expect(AVISO_RESPONSABILIDADE).toMatch(/responsabilidade tecnica/i);
    expect(AVISO_RESPONSABILIDADE).toMatch(/contador responsavel/i);
    expect(AVISO_RESPONSABILIDADE).toMatch(/apoio a decisao/i);
  });

  it('o resultado nao validado carrega a marca de provisorio', async () => {
    const resultado = await simular(params);
    expect(resultado.validadoPorProfissional).toBe(false);
    expect(resultado.observacoes.join(' ')).toMatch(/PROVISORIA/i);
  });
});
