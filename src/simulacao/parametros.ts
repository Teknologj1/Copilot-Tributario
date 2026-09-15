import parametrosJson from './parametros/transicao.json';
import type { AnexoSimples } from './interface';

/**
 * Carregador tipado do arquivo de parametros fiscais.
 *
 * Todo numero fiscal do sistema vive em parametros/transicao.json. Este modulo
 * so da forma a ele. Se o contador precisar corrigir uma aliquota, ele edita o
 * JSON — nao o codigo.
 */

export interface FaixaSimples {
  ate: number;
  aliquota: number;
  deduzir: number;
}

export interface AnoTransicao {
  cbs: number;
  ibs: number;
  /** Fracao dos tributos antigos (ICMS/ISS/PIS/COFINS) ainda devida no ano. */
  parcelaTributosAntigos: number;
  nota: string;
}

export type Atividade = 'comercio' | 'industria' | 'servicos';

export const parametros = parametrosJson as unknown as {
  versaoParametros: string;
  atualizadoEm: string;
  revisadoPor: string | null;
  revisadoEm: string | null;
  tabelasSimples: {
    anexos: Record<AnexoSimples, { descricao: string; faixas: FaixaSimples[] }>;
    fatorR: { limite: number; descricao: string; aplicaAosAnexos: string[] };
    limiteReceitaBrutaAnual: number;
  };
  transicaoIbsCbs: { anos: Record<string, AnoTransicao> };
  regimeRegular: {
    lucroPresumido: {
      presuncaoComercio: number;
      presuncaoIndustria: number;
      presuncaoServicos: number;
      irpj: number;
      irpjAdicional: number;
      irpjLimiteAdicionalAnual: number;
      csll: number;
      csllPresuncaoComercio: number;
      csllPresuncaoServicos: number;
    };
    cppPatronalSobreFolha: number;
  };
  creditamento: {
    creditoTransferidoDentroDAS: number;
    creditoTransferidoForaDAS: number;
    impactoComercialB2B: { fatorRepasse: number };
  };
  mapaAnexoParaAtividade: Record<AnexoSimples, Atividade>;
};

export const ANOS_TRANSICAO: number[] = Object.keys(parametros.transicaoIbsCbs.anos)
  .map(Number)
  .sort((a, b) => a - b);

export const PRIMEIRO_ANO = ANOS_TRANSICAO[0] as number;
export const ULTIMO_ANO = ANOS_TRANSICAO[ANOS_TRANSICAO.length - 1] as number;

export function anoTransicao(ano: number): AnoTransicao {
  const direto = parametros.transicaoIbsCbs.anos[String(ano)];
  if (direto) return direto;

  // Fora da janela parametrizada: antes de 2026 nao ha reforma; depois de 2033
  // o regime ja e integral. Nao extrapolar inventando numero intermediario.
  const alvo = ano < PRIMEIRO_ANO ? PRIMEIRO_ANO : ULTIMO_ANO;
  return parametros.transicaoIbsCbs.anos[String(alvo)] as AnoTransicao;
}

export function anexoValido(anexo: string): anexo is AnexoSimples {
  return ['I', 'II', 'III', 'IV', 'V'].includes(anexo);
}

export function atividadeDoAnexo(anexo: AnexoSimples): Atividade {
  return parametros.mapaAnexoParaAtividade[anexo];
}

/** Versao combinada motor+parametros, carimbada em cada resultado e laudo. */
export const VERSAO_PARAMETROS = parametros.versaoParametros;
