import { config, ehProducao } from '../config';
import { ErroMotorNaoValidado, ErroValidacao } from '../comum/erros';
import { cnpjValido, normalizarCnpj } from '../comum/cnpj';
import {
  anexoValido,
  anoTransicao,
  atividadeDoAnexo,
  ANOS_TRANSICAO,
  parametros,
  VERSAO_PARAMETROS,
  type Atividade,
} from './parametros';
import type {
  AnexoSimples,
  Confianca,
  LinhaMemoriaCalculo,
  ParametrosSimulacao,
  Recomendacao,
  ResultadoSimulacao,
  ResultadoSimulacaoAno,
} from './interface';

/**
 * MOTOR DE SIMULACAO DENTRO/FORA DO DAS — secao 6.
 *
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │ AVISO — LEIA ANTES DE LIGAR ISTO EM PRODUCAO                          │
 * │                                                                        │
 * │ As regras implementadas aqui NAO foram revisadas por contador ou       │
 * │ tributarista. A propria especificacao (secao 6) classifica este modulo │
 * │ como o maior risco tecnico e de responsabilidade profissional do       │
 * │ produto, e o criterio de aceite da secao 10 exige revisao formal antes │
 * │ de uso real.                                                           │
 * │                                                                        │
 * │ Enquanto MOTOR_VALIDADO nao for 'true':                                │
 * │   - todo resultado sai com confianca 'baixa';                          │
 * │   - o laudo carimba que a simulacao e provisoria;                      │
 * │   - rodar com NODE_ENV=producao lanca ErroMotorNaoValidado.            │
 * │                                                                        │
 * │ O que o revisor precisa olhar, em ordem de risco:                      │
 * │   1. parametros/transicao.json → creditamento (coracao da decisao B2B) │
 * │   2. parametros/transicao.json → transicaoIbsCbs (calendario/aliquotas)│
 * │   3. as tres funcoes de calculo deste arquivo                          │
 * │   4. parametros/transicao.json → regimeRegular (proxy Lucro Presumido) │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * O desenho e proposital: nenhuma aliquota esta escrita neste arquivo. O que
 * esta aqui sao as FORMULAS; os NUMEROS estao todos no JSON de parametros.
 */

export const VERSAO_MOTOR = '0.1.0';
export const VERSAO_COMPLETA = `motor ${VERSAO_MOTOR} / parametros ${VERSAO_PARAMETROS}`;

/** Anos usados no laudo quando o chamador nao pede um ano especifico (5.4). */
export const ANOS_AMOSTRA = [2026, 2027, 2030, 2033];

interface Memoria {
  linhas: LinhaMemoriaCalculo[];
  registrar(
    ano: number,
    cenario: 'dentro_das' | 'fora_das',
    rubrica: string,
    valor: number,
    formula: string,
  ): number;
}

function novaMemoria(): Memoria {
  const linhas: LinhaMemoriaCalculo[] = [];
  return {
    linhas,
    registrar(ano, cenario, rubrica, valor, formula) {
      linhas.push({ ano, cenario, rubrica, valor: arredondar(valor), formula });
      return valor;
    },
  };
}

function arredondar(valor: number): number {
  return Math.round(valor * 100) / 100;
}

// ---------------------------------------------------------------------------
// Cenario 1: DENTRO do DAS (permanece recolhendo pelo Simples Nacional)
// ---------------------------------------------------------------------------

/**
 * Aliquota efetiva do Simples: (RBT12 * aliquotaNominal - parcelaDeduzir) / RBT12.
 * Faturamento acima do teto do Simples nao tem aliquota definida — quem passa
 * do limite esta desenquadrado, e isso e sinalizado como observacao.
 */
export function aliquotaEfetivaSimples(
  anexo: AnexoSimples,
  receitaBruta12m: number,
): number {
  const faixas = parametros.tabelasSimples.anexos[anexo].faixas;
  const faixa = faixas.find((f) => receitaBruta12m <= f.ate) ?? faixas[faixas.length - 1];
  if (!faixa || receitaBruta12m <= 0) return 0;
  return (receitaBruta12m * faixa.aliquota - faixa.deduzir) / receitaBruta12m;
}

/**
 * Fator R decide entre Anexo III e V para prestadores de servico.
 * Sem folha informada, nao da para calcular — mantem o anexo declarado e a
 * simulacao registra a lacuna (rebaixando a confianca).
 */
export function aplicarFatorR(
  anexoDeclarado: AnexoSimples,
  faturamento12m: number,
  folha12m?: number,
): { anexo: AnexoSimples; fatorR?: number; aplicado: boolean } {
  const { fatorR } = parametros.tabelasSimples;
  if (!fatorR.aplicaAosAnexos.includes(anexoDeclarado)) {
    return { anexo: anexoDeclarado, aplicado: false };
  }
  if (folha12m === undefined || faturamento12m <= 0) {
    return { anexo: anexoDeclarado, aplicado: false };
  }
  const valor = folha12m / faturamento12m;
  return { anexo: valor >= fatorR.limite ? 'III' : 'V', fatorR: valor, aplicado: true };
}

function calcularDentroDAS(
  params: ParametrosSimulacao,
  anexo: AnexoSimples,
  ano: number,
  memoria: Memoria,
): number {
  const faturamento = params.faturamentoBrutoAnual;
  const efetiva = aliquotaEfetivaSimples(anexo, faturamento);

  const das = memoria.registrar(
    ano,
    'dentro_das',
    `DAS — Anexo ${anexo}`,
    faturamento * efetiva,
    `faturamento (${faturamento}) x aliquota efetiva (${(efetiva * 100).toFixed(2)}%)`,
  );

  // Custo indireto: dentro do DAS o cliente B2B aproveita credito de IBS/CBS
  // apenas parcialmente. A diferenca tende a virar pressao de preco sobre o
  // fornecedor. Modelado como custo comercial, nao como tributo.
  const t = anoTransicao(ano);
  const aliquotaIbsCbs = t.cbs + t.ibs;
  const { creditoTransferidoDentroDAS, creditoTransferidoForaDAS, impactoComercialB2B } =
    parametros.creditamento;

  const receitaB2B = faturamento * (params.composicaoReceita.percentualB2B / 100);
  const creditoPerdido =
    receitaB2B * aliquotaIbsCbs * (creditoTransferidoForaDAS - creditoTransferidoDentroDAS);
  const custoComercial = memoria.registrar(
    ano,
    'dentro_das',
    'Custo comercial estimado (credito que o cliente B2B deixa de tomar)',
    creditoPerdido * impactoComercialB2B.fatorRepasse,
    `receita B2B (${arredondar(receitaB2B)}) x aliquota IBS+CBS (${(aliquotaIbsCbs * 100).toFixed(2)}%) ` +
      `x diferenca de credito (${creditoTransferidoForaDAS - creditoTransferidoDentroDAS}) ` +
      `x fator de repasse (${impactoComercialB2B.fatorRepasse})`,
  );

  const total = das + custoComercial;
  memoria.registrar(ano, 'dentro_das', 'Total dentro do DAS', total, 'DAS + custo comercial');
  return total;
}

// ---------------------------------------------------------------------------
// Cenario 2: FORA do DAS (recolhe IBS/CBS por fora, regime regular)
// ---------------------------------------------------------------------------

function presuncaoIrpj(atividade: Atividade): number {
  const lp = parametros.regimeRegular.lucroPresumido;
  if (atividade === 'servicos') return lp.presuncaoServicos;
  if (atividade === 'industria') return lp.presuncaoIndustria;
  return lp.presuncaoComercio;
}

function presuncaoCsll(atividade: Atividade): number {
  const lp = parametros.regimeRegular.lucroPresumido;
  return atividade === 'servicos' ? lp.csllPresuncaoServicos : lp.csllPresuncaoComercio;
}

function calcularForaDAS(
  params: ParametrosSimulacao,
  atividade: Atividade,
  ano: number,
  memoria: Memoria,
): number {
  const faturamento = params.faturamentoBrutoAnual;
  const lp = parametros.regimeRegular.lucroPresumido;
  const t = anoTransicao(ano);

  // --- IBS/CBS sobre valor agregado (debito menos credito de insumos) ---
  const aliquota = t.cbs + t.ibs;
  const compras = params.comprasComCredito ?? 0;
  const debito = faturamento * aliquota;
  const credito = compras * aliquota;
  const ibsCbs = memoria.registrar(
    ano,
    'fora_das',
    'IBS + CBS (nao cumulativo)',
    Math.max(0, debito - credito),
    `[faturamento (${faturamento}) - compras com credito (${compras})] x aliquota (${(aliquota * 100).toFixed(2)}%)`,
  );

  // --- IRPJ + CSLL pelo Lucro Presumido (proxy do regime regular) ---
  const baseIrpj = faturamento * presuncaoIrpj(atividade);
  const irpjBasico = baseIrpj * lp.irpj;
  const excedente = Math.max(0, baseIrpj - lp.irpjLimiteAdicionalAnual);
  const irpjAdicional = excedente * lp.irpjAdicional;
  const irpj = memoria.registrar(
    ano,
    'fora_das',
    'IRPJ (lucro presumido)',
    irpjBasico + irpjAdicional,
    `base presumida (${arredondar(baseIrpj)}) x ${lp.irpj * 100}% + excedente (${arredondar(excedente)}) x ${lp.irpjAdicional * 100}%`,
  );

  const baseCsll = faturamento * presuncaoCsll(atividade);
  const csll = memoria.registrar(
    ano,
    'fora_das',
    'CSLL (lucro presumido)',
    baseCsll * lp.csll,
    `base presumida (${arredondar(baseCsll)}) x ${lp.csll * 100}%`,
  );

  // --- CPP patronal: fora do Simples a folha volta a ser tributada ---
  const folha = params.folhaSalarios12m ?? 0;
  const cpp = memoria.registrar(
    ano,
    'fora_das',
    'CPP patronal sobre folha',
    folha * parametros.regimeRegular.cppPatronalSobreFolha,
    `folha 12m (${folha}) x ${(parametros.regimeRegular.cppPatronalSobreFolha * 100).toFixed(2)}%`,
  );

  // --- Tributos antigos ainda devidos durante a transicao ---
  // Durante 2026-2032 parte de ICMS/ISS/PIS/COFINS convive com IBS/CBS. A
  // parcela e parametrizada; o proxy usa a propria carga IBS/CBS como base de
  // grandeza, o que e uma SIMPLIFICACAO relevante (ver observacoes).
  const antigos = memoria.registrar(
    ano,
    'fora_das',
    'Tributos do regime antigo ainda devidos na transicao',
    ibsCbs * t.parcelaTributosAntigos,
    `carga IBS/CBS (${arredondar(ibsCbs)}) x parcela remanescente (${t.parcelaTributosAntigos}) — aproximacao`,
  );

  const total = ibsCbs + irpj + csll + cpp + antigos;
  memoria.registrar(
    ano,
    'fora_das',
    'Total fora do DAS',
    total,
    'IBS/CBS + IRPJ + CSLL + CPP + tributos antigos da transicao',
  );
  return total;
}

// ---------------------------------------------------------------------------
// Orquestracao
// ---------------------------------------------------------------------------

function validarEntrada(params: ParametrosSimulacao): string[] {
  const problemas: string[] = [];

  if (!cnpjValido(params.cnpj)) {
    throw new ErroValidacao('CNPJ invalido para simulacao', { cnpj: params.cnpj });
  }
  if (!Number.isFinite(params.faturamentoBrutoAnual) || params.faturamentoBrutoAnual <= 0) {
    throw new ErroValidacao('faturamentoBrutoAnual deve ser um numero positivo');
  }
  if (!anexoValido(params.anexoSimples)) {
    throw new ErroValidacao(
      `anexoSimples invalido: "${params.anexoSimples}". Use I, II, III, IV ou V.`,
    );
  }

  const { percentualB2B, percentualB2C } = params.composicaoReceita;
  const soma = percentualB2B + percentualB2C;
  if (Math.abs(soma - 100) > 0.51) {
    throw new ErroValidacao(
      `composicaoReceita deve somar 100% (recebeu ${soma}%).`,
    );
  }

  return problemas;
}

/**
 * Determina a confianca do resultado.
 *
 * Regra dura da secao 6, item 4: enquanto o motor nao estiver validado por
 * profissional, a confianca e 'baixa' — nao importa quao completos sejam os
 * dados de entrada. Dados faltantes so podem rebaixar, nunca elevar.
 */
export function calcularConfianca(params: ParametrosSimulacao, lacunas: string[]): Confianca {
  if (!config.simulacao.motorValidado) return 'baixa';
  if (lacunas.length > 0) return 'baixa';

  const precisaFatorR = ['III', 'V'].includes(params.anexoSimples);
  if (precisaFatorR && params.folhaSalarios12m === undefined) return 'media';
  if (params.comprasComCredito === undefined) return 'media';
  if (!params.uf) return 'media';

  return 'alta';
}

function cicloAtual(data = new Date()): string {
  return `${data.getUTCFullYear()}-${String(data.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface OpcoesSimulacao {
  /** Anos a projetar. Padrao: ANOS_AMOSTRA (2026, 2027, 2030, 2033). */
  anos?: number[];
  /** Ciclo de decisao — padrao: mes corrente. */
  ciclo?: string;
}

/**
 * Assinatura exigida pela secao 6:
 *   function simular(params: ParametrosSimulacao): Promise<ResultadoSimulacao>
 *
 * `opcoes` e um extra opcional (projecao multi-ano do laudo) — chamadas que
 * passam so `params` continuam validas.
 */
export async function simular(
  params: ParametrosSimulacao,
  opcoes: OpcoesSimulacao = {},
): Promise<ResultadoSimulacao> {
  // Trava profissional: nunca rodar calculo nao revisado em producao.
  if (!config.simulacao.motorValidado && ehProducao()) {
    throw new ErroMotorNaoValidado();
  }

  validarEntrada(params);

  const observacoes: string[] = [];
  const lacunas: string[] = [];
  const memoria = novaMemoria();

  const cnpj = normalizarCnpj(params.cnpj);
  const faturamento = params.faturamentoBrutoAnual;

  // Anexo efetivo (Fator R pode reclassificar III <-> V).
  const declarado = params.anexoSimples as AnexoSimples;
  const fator = aplicarFatorR(declarado, faturamento, params.folhaSalarios12m);
  const anexo = fator.anexo;

  if (fator.aplicado) {
    observacoes.push(
      `Fator R calculado em ${(fator.fatorR! * 100).toFixed(1)}% — tributacao pelo Anexo ${anexo}.`,
    );
  } else if (['III', 'V'].includes(declarado)) {
    lacunas.push('folhaSalarios12m');
    observacoes.push(
      'Folha de salarios nao informada: o Fator R nao pode ser calculado e foi ' +
        `mantido o Anexo ${declarado} declarado. Informar a folha muda o resultado de forma relevante.`,
    );
  }

  if (params.comprasComCredito === undefined) {
    lacunas.push('comprasComCredito');
    observacoes.push(
      'Compras com direito a credito nao informadas: o cenario fora do DAS foi ' +
        'calculado sem creditos de insumos, o que o penaliza. Informar as compras tende a favorece-lo.',
    );
  }

  if (faturamento > parametros.tabelasSimples.limiteReceitaBrutaAnual) {
    observacoes.push(
      `Faturamento acima do teto do Simples (${parametros.tabelasSimples.limiteReceitaBrutaAnual.toLocaleString('pt-BR')}): ` +
        'a permanencia dentro do DAS pode nem ser uma opcao legal. Confirmar enquadramento.',
    );
  }

  observacoes.push('Calculo nao considera regras estaduais especificas de ICMS nem beneficios setoriais.');
  observacoes.push('Nao considera Imposto Seletivo, regimes especificos (LC 214/2025) nem Zona Franca de Manaus.');

  if (!config.simulacao.motorValidado) {
    observacoes.unshift(
      'SIMULACAO PROVISORIA: as regras de calculo ainda nao foram revisadas por ' +
        'contador ou tributarista. Use como ordem de grandeza, nunca como base de decisao final.',
    );
  }

  const atividade = atividadeDoAnexo(anexo);
  const anos = (opcoes.anos ?? ANOS_AMOSTRA).slice().sort((a, b) => a - b);

  const projecaoPorAno: ResultadoSimulacaoAno[] = anos.map((ano) => {
    const dentro = calcularDentroDAS(params, anexo, ano, memoria);
    const fora = calcularForaDAS(params, atividade, ano, memoria);
    return {
      ano,
      cargaTributariaDentroDAS: arredondar(dentro),
      cargaTributariaForaDAS: arredondar(fora),
      diferenca: arredondar(fora - dentro),
    };
  });

  const recomendacao = decidirRecomendacao(projecaoPorAno);

  return {
    cnpj,
    cicloDecisao: opcoes.ciclo ?? cicloAtual(),
    recomendacao,
    confianca: calcularConfianca(params, lacunas),
    projecaoPorAno,
    observacoes,
    versaoMotor: VERSAO_COMPLETA,
    validadoPorProfissional: config.simulacao.motorValidado,
    memoriaCalculo: memoria.linhas,
    calculadoEm: new Date().toISOString(),
  };
}

/**
 * Decide pela carga acumulada de toda a projecao, nao pelo primeiro ano: a
 * transicao inverte o jogo no meio do caminho em varios perfis, e otimizar
 * 2026 isolado leva a decisao errada para 2033.
 */
export function decidirRecomendacao(projecao: ResultadoSimulacaoAno[]): Recomendacao {
  const acumulado = projecao.reduce((acc, p) => acc + p.diferenca, 0);
  // Empate favorece ficar dentro do DAS: manter o regime atual e a opcao de
  // menor custo operacional e menor risco para a empresa.
  return acumulado < 0 ? 'fora_das' : 'dentro_das';
}

export { ANOS_TRANSICAO };
