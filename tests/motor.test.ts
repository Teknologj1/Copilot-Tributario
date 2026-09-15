import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  simular,
  aliquotaEfetivaSimples,
  aplicarFatorR,
  decidirRecomendacao,
  calcularConfianca,
  ANOS_AMOSTRA,
} from '../src/simulacao/motor';
import { parametros, anoTransicao, atividadeDoAnexo } from '../src/simulacao/parametros';
import { ErroMotorNaoValidado, ErroValidacao } from '../src/comum/erros';
import { config } from '../src/config';
import type { ParametrosSimulacao } from '../src/simulacao/interface';

const base: ParametrosSimulacao = {
  cnpj: '12345678000195',
  anexoSimples: 'I',
  faturamentoBrutoAnual: 900000,
  composicaoReceita: { percentualB2B: 70, percentualB2C: 30 },
  ano: 2026,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('aliquota efetiva do Simples', () => {
  it('aplica a formula (RBT12 x nominal - deduzir) / RBT12', () => {
    // Anexo I, 4a faixa: 10,7% com deducao de 22.500 sobre 900k
    // (900000 * 0,107 - 22500) / 900000 = 8,2%
    expect(aliquotaEfetivaSimples('I', 900000)).toBeCloseTo(0.082, 4);
  });

  it('na primeira faixa a efetiva iguala a nominal (deducao zero)', () => {
    const primeira = parametros.tabelasSimples.anexos.I.faixas[0]!;
    expect(aliquotaEfetivaSimples('I', 100000)).toBeCloseTo(primeira.aliquota, 6);
  });

  it('cresce conforme o faturamento sobe de faixa', () => {
    const efetivas = [100000, 300000, 600000, 1500000, 3000000].map((r) =>
      aliquotaEfetivaSimples('I', r),
    );
    for (let i = 1; i < efetivas.length; i += 1) {
      expect(efetivas[i]!).toBeGreaterThan(efetivas[i - 1]!);
    }
  });

  it('nao explode com faturamento zero', () => {
    expect(aliquotaEfetivaSimples('I', 0)).toBe(0);
  });
});

describe('Fator R', () => {
  it('folha >= 28% da receita leva ao Anexo III', () => {
    const r = aplicarFatorR('V', 1000000, 300000);
    expect(r.anexo).toBe('III');
    expect(r.aplicado).toBe(true);
    expect(r.fatorR).toBeCloseTo(0.3, 4);
  });

  it('folha < 28% leva ao Anexo V', () => {
    const r = aplicarFatorR('III', 1000000, 100000);
    expect(r.anexo).toBe('V');
    expect(r.aplicado).toBe(true);
  });

  it('nao se aplica a comercio e industria', () => {
    expect(aplicarFatorR('I', 1000000, 500000).aplicado).toBe(false);
    expect(aplicarFatorR('II', 1000000, 500000).anexo).toBe('II');
  });

  it('sem folha informada, mantem o anexo declarado', () => {
    const r = aplicarFatorR('III', 1000000, undefined);
    expect(r.anexo).toBe('III');
    expect(r.aplicado).toBe(false);
  });
});

describe('simular()', () => {
  it('projeta os anos-amostra e calcula a diferenca', async () => {
    const r = await simular(base);

    expect(r.projecaoPorAno.map((p) => p.ano)).toEqual(ANOS_AMOSTRA);
    for (const ano of r.projecaoPorAno) {
      expect(ano.diferenca).toBeCloseTo(
        ano.cargaTributariaForaDAS - ano.cargaTributariaDentroDAS,
        2,
      );
    }
  });

  it('aceita uma janela de anos customizada', async () => {
    const r = await simular(base, { anos: [2026, 2033] });
    expect(r.projecaoPorAno.map((p) => p.ano)).toEqual([2026, 2033]);
  });

  it('produz memoria de calculo para todos os anos e cenarios', async () => {
    const r = await simular(base);

    for (const ano of ANOS_AMOSTRA) {
      const doAno = r.memoriaCalculo.filter((l) => l.ano === ano);
      expect(doAno.some((l) => l.cenario === 'dentro_das')).toBe(true);
      expect(doAno.some((l) => l.cenario === 'fora_das')).toBe(true);
    }
    // Toda linha explica de onde saiu o numero.
    expect(r.memoriaCalculo.every((l) => l.formula.length > 0)).toBe(true);
  });

  it('o total da memoria reconstroi a carga da projecao', async () => {
    const r = await simular(base);
    const ano = r.projecaoPorAno[0]!;

    const totalDentro = r.memoriaCalculo.find(
      (l) => l.ano === ano.ano && l.rubrica === 'Total dentro do DAS',
    );
    expect(totalDentro?.valor).toBeCloseTo(ano.cargaTributariaDentroDAS, 2);
  });

  it('reclassifica pelo Fator R e registra nas observacoes', async () => {
    const r = await simular({ ...base, anexoSimples: 'V', folhaSalarios12m: 400000 });
    expect(r.observacoes.join(' ')).toMatch(/Fator R/);
  });

  it('avisa quando a folha nao foi informada para Anexo III/V', async () => {
    const r = await simular({ ...base, anexoSimples: 'III' });
    expect(r.observacoes.join(' ')).toMatch(/Folha de salarios nao informada/i);
  });

  it('avisa quando o faturamento passa do teto do Simples', async () => {
    const r = await simular({ ...base, faturamentoBrutoAnual: 6000000 });
    expect(r.observacoes.join(' ')).toMatch(/teto do Simples/i);
  });

  it('sempre registra as limitacoes estruturais', async () => {
    const r = await simular(base);
    const texto = r.observacoes.join(' ');
    expect(texto).toMatch(/ICMS/);
    expect(texto).toMatch(/Zona Franca|Imposto Seletivo/);
  });

  it('mais clientela B2B nunca favorece ficar dentro do DAS', async () => {
    const poucoB2B = await simular({
      ...base,
      composicaoReceita: { percentualB2B: 10, percentualB2C: 90 },
    });
    const muitoB2B = await simular({
      ...base,
      composicaoReceita: { percentualB2B: 90, percentualB2C: 10 },
    });

    const somaDentro = (r: typeof poucoB2B) =>
      r.projecaoPorAno.reduce((s, a) => s + a.cargaTributariaDentroDAS, 0);

    // O custo do credito perdido recai sobre a parcela B2B.
    expect(somaDentro(muitoB2B)).toBeGreaterThan(somaDentro(poucoB2B));
  });

  it('informar compras com credito melhora o cenario fora do DAS', async () => {
    const sem = await simular(base);
    const com = await simular({ ...base, comprasComCredito: 400000 });

    const somaFora = (r: typeof sem) =>
      r.projecaoPorAno.reduce((s, a) => s + a.cargaTributariaForaDAS, 0);

    expect(somaFora(com)).toBeLessThan(somaFora(sem));
  });
});

describe('validacao de entrada', () => {
  it('rejeita CNPJ invalido', async () => {
    await expect(simular({ ...base, cnpj: '12345678000190' })).rejects.toThrow(ErroValidacao);
  });

  it('rejeita faturamento nao positivo', async () => {
    await expect(simular({ ...base, faturamentoBrutoAnual: 0 })).rejects.toThrow(ErroValidacao);
    await expect(simular({ ...base, faturamentoBrutoAnual: -1 })).rejects.toThrow(ErroValidacao);
  });

  it('rejeita anexo desconhecido', async () => {
    await expect(simular({ ...base, anexoSimples: 'VII' })).rejects.toThrow(/anexoSimples/i);
  });

  it('rejeita composicao de receita que nao soma 100%', async () => {
    await expect(
      simular({ ...base, composicaoReceita: { percentualB2B: 70, percentualB2C: 10 } }),
    ).rejects.toThrow(/100%/);
  });

  it('tolera arredondamento de meio ponto na composicao', async () => {
    await expect(
      simular({ ...base, composicaoReceita: { percentualB2B: 73.3, percentualB2C: 26.7 } }),
    ).resolves.toBeDefined();
  });
});

describe('trava profissional (secao 6)', () => {
  it('confianca e sempre baixa enquanto o motor nao for validado', async () => {
    const completo = await simular({
      ...base,
      folhaSalarios12m: 200000,
      comprasComCredito: 300000,
      uf: 'SP',
    });

    expect(config.simulacao.motorValidado).toBe(false);
    expect(completo.confianca).toBe('baixa');
    expect(completo.validadoPorProfissional).toBe(false);
  });

  it('carimba o resultado como provisorio nas observacoes', async () => {
    const r = await simular(base);
    expect(r.observacoes[0]).toMatch(/PROVISORIA/i);
  });

  it('dados completos so elevam a confianca depois da validacao', () => {
    vi.spyOn(config.simulacao, 'motorValidado', 'get').mockReturnValue(true);

    expect(
      calcularConfianca(
        { ...base, folhaSalarios12m: 1, comprasComCredito: 1, uf: 'SP' },
        [],
      ),
    ).toBe('alta');

    // Lacuna conhecida rebaixa mesmo com o motor validado.
    expect(calcularConfianca(base, ['folhaSalarios12m'])).toBe('baixa');
    expect(calcularConfianca({ ...base, comprasComCredito: 1 }, [])).toBe('media');
  });

  it('recusa rodar em producao sem validacao profissional', async () => {
    vi.spyOn(config, 'ambiente', 'get').mockReturnValue('producao');

    await expect(simular(base)).rejects.toThrow(ErroMotorNaoValidado);
    await expect(simular(base)).rejects.toThrow(/contador|tributarista/i);
  });

  it('carimba a versao do motor e dos parametros no resultado', async () => {
    const r = await simular(base);
    expect(r.versaoMotor).toMatch(/motor .+ parametros .+/);
    expect(r.versaoMotor).toContain('nao-validado');
  });
});

describe('recomendacao', () => {
  it('decide pela carga acumulada, nao pelo primeiro ano', () => {
    // Primeiro ano favorece sair (negativo), mas o acumulado favorece ficar.
    const projecao = [
      { ano: 2026, cargaTributariaDentroDAS: 100, cargaTributariaForaDAS: 50, diferenca: -50 },
      { ano: 2033, cargaTributariaDentroDAS: 100, cargaTributariaForaDAS: 300, diferenca: 200 },
    ];
    expect(decidirRecomendacao(projecao)).toBe('dentro_das');
  });

  it('empate mantem o regime atual', () => {
    expect(
      decidirRecomendacao([
        { ano: 2026, cargaTributariaDentroDAS: 100, cargaTributariaForaDAS: 100, diferenca: 0 },
      ]),
    ).toBe('dentro_das');
  });
});

describe('parametros fiscais', () => {
  it('cobre todos os anos da transicao de 2026 a 2033', () => {
    for (let ano = 2026; ano <= 2033; ano += 1) {
      expect(parametros.transicaoIbsCbs.anos[String(ano)]).toBeDefined();
    }
  });

  it('nao extrapola fora da janela parametrizada', () => {
    expect(anoTransicao(2020)).toEqual(parametros.transicaoIbsCbs.anos['2026']);
    expect(anoTransicao(2040)).toEqual(parametros.transicaoIbsCbs.anos['2033']);
  });

  it('a parcela de tributos antigos decresce ate zerar em 2033', () => {
    const anos = [2026, 2027, 2029, 2030, 2031, 2032, 2033];
    const parcelas = anos.map((a) => anoTransicao(a).parcelaTributosAntigos);

    for (let i = 1; i < parcelas.length; i += 1) {
      expect(parcelas[i]!).toBeLessThanOrEqual(parcelas[i - 1]!);
    }
    expect(anoTransicao(2033).parcelaTributosAntigos).toBe(0);
  });

  it('mapeia cada anexo a uma atividade', () => {
    expect(atividadeDoAnexo('I')).toBe('comercio');
    expect(atividadeDoAnexo('II')).toBe('industria');
    expect(atividadeDoAnexo('III')).toBe('servicos');
    expect(atividadeDoAnexo('V')).toBe('servicos');
  });

  it('todas as faixas dos cinco anexos estao ordenadas', () => {
    for (const anexo of ['I', 'II', 'III', 'IV', 'V'] as const) {
      const faixas = parametros.tabelasSimples.anexos[anexo].faixas;
      expect(faixas.length).toBeGreaterThan(0);
      for (let i = 1; i < faixas.length; i += 1) {
        expect(faixas[i]!.ate).toBeGreaterThan(faixas[i - 1]!.ate);
      }
    }
  });
});
