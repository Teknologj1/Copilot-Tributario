import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  extrairDadosFiscais,
  anualizarFaturamento,
  camposFaltantes,
} from '../src/parser';
import { ErroParser } from '../src/comum/erros';

const fixture = (nome: string): Buffer =>
  fs.readFileSync(path.join(__dirname, 'fixtures', nome));

describe('parser de XML de NF-e', () => {
  it('le um lote, soma so as saidas e pondera B2B por valor', async () => {
    const dados = await extrairDadosFiscais(fixture('nfe-lote.xml'), 'xml_nfe');

    expect(dados.cnpj).toBe('12345678000195');
    expect(dados.razaoSocial).toBe('PADARIA MODELO LTDA');
    expect(dados.uf).toBe('SP');

    // 60k (B2B) + 40k (B2C) + 50k (B2B) = 150k; a nota de entrada (5k) fica fora.
    expect(dados.faturamentoBruto).toBe(150000);
    expect(dados.documentosProcessados).toBe(3);

    // B2B = 110k / 150k = 73,3% — ponderado por valor, nao por contagem de notas.
    expect(dados.composicaoReceita.percentualB2B).toBeCloseTo(73.3, 1);
    expect(dados.composicaoReceita.percentualB2C).toBeCloseTo(26.7, 1);
    expect(
      dados.composicaoReceita.percentualB2B + dados.composicaoReceita.percentualB2C,
    ).toBeCloseTo(100, 1);
  });

  it('identifica o periodo coberto e avisa sobre a nota de entrada', async () => {
    const dados = await extrairDadosFiscais(fixture('nfe-lote.xml'), 'xml_nfe');

    expect(dados.periodos).toEqual(['2026-01', '2026-02']);
    expect(dados.periodo).toBe('2026-02');
    expect(dados.mesesCobertos).toBe(2);
    expect(dados.avisos.join(' ')).toMatch(/entrada/i);
  });

  it('le o CRT do emitente', async () => {
    const dados = await extrairDadosFiscais(fixture('nfe-lote.xml'), 'xml_nfe');
    expect(dados.regimeTributarioDeclarado).toBe(1); // Simples Nacional
  });

  it('anualiza extrapolando os meses cobertos', async () => {
    const dados = await extrairDadosFiscais(fixture('nfe-lote.xml'), 'xml_nfe');
    // 150k em 2 meses -> 900k/ano
    expect(anualizarFaturamento(dados)).toBe(900000);
  });

  it('nao extrapola quando ja ha 12 meses', () => {
    const doze = { faturamentoBruto: 1200000, mesesCobertos: 12 } as never;
    expect(anualizarFaturamento(doze)).toBe(1200000);
  });

  it('aponta os campos que o XML nao fornece', async () => {
    const dados = await extrairDadosFiscais(fixture('nfe-lote.xml'), 'xml_nfe');
    const campos = camposFaltantes(dados).map((c) => c.campo);

    expect(campos).toContain('anexoSimples');
    expect(campos).toContain('comprasComCredito');
    // Anexo e o unico bloqueante; os outros so reduzem a confianca.
    expect(camposFaltantes(dados).find((c) => c.campo === 'anexoSimples')?.obrigatorio).toBe(true);
    expect(
      camposFaltantes(dados).find((c) => c.campo === 'comprasComCredito')?.obrigatorio,
    ).toBe(false);
  });

  it('so pergunta a folha nos anexos em que o Fator R decide', async () => {
    const dados = await extrairDadosFiscais(fixture('nfe-lote.xml'), 'xml_nfe');

    const pedeFolha = (anexo?: string) =>
      camposFaltantes({ ...dados, anexoSimples: anexo }).some(
        (c) => c.campo === 'folhaSalarios12m',
      );

    expect(pedeFolha('III')).toBe(true);
    expect(pedeFolha('V')).toBe(true);
    // Comercio e industria nao usam Fator R — perguntar a folha seria ruido.
    expect(pedeFolha('I')).toBe(false);
    expect(pedeFolha('II')).toBe(false);
    expect(pedeFolha('IV')).toBe(false);
  });

  it('respeita o CNPJ alvo quando o lote tem varios emitentes', async () => {
    const dados = await extrairDadosFiscais(fixture('nfe-multi-emitente.xml'), 'xml_nfe', {
      cnpjAlvo: '98765432000198',
    });

    expect(dados.cnpj).toBe('98765432000198');
    expect(dados.faturamentoBruto).toBe(20000);
  });

  it('sem CNPJ alvo, escolhe o emitente de maior faturamento e avisa', async () => {
    const dados = await extrairDadosFiscais(fixture('nfe-multi-emitente.xml'), 'xml_nfe');

    expect(dados.cnpj).toBe('12345678000195');
    expect(dados.avisos.join(' ')).toMatch(/2 emitentes/);
  });

  it('erra de forma util quando o CNPJ alvo nao esta no arquivo', async () => {
    await expect(
      extrairDadosFiscais(fixture('nfe-lote.xml'), 'xml_nfe', { cnpjAlvo: '11222333000181' }),
    ).rejects.toThrow(ErroParser);
  });

  it('rejeita XML que nao e NF-e', async () => {
    await expect(
      extrairDadosFiscais(Buffer.from('<outraCoisa><a>1</a></outraCoisa>'), 'xml_nfe'),
    ).rejects.toThrow(/Nenhuma NF-e/i);
  });

  it('rejeita arquivo vazio', async () => {
    await expect(extrairDadosFiscais(Buffer.from(''), 'xml_nfe')).rejects.toThrow(/vazio/i);
  });

  it('rejeita arquivo so com notas de entrada', async () => {
    await expect(
      extrairDadosFiscais(fixture('nfe-so-entrada.xml'), 'xml_nfe'),
    ).rejects.toThrow(/saida/i);
  });

  it('PGDAS e SPED avisam que sao de Fase 2', async () => {
    await expect(extrairDadosFiscais(Buffer.from('x'), 'pgdas')).rejects.toThrow(/Fase 2/i);
    await expect(extrairDadosFiscais(Buffer.from('x'), 'sped')).rejects.toThrow(/Fase 2/i);
  });
});
