/**
 * Contrato do motor de simulacao — secao 6 da especificacao.
 *
 * Estes tipos sao a fronteira estavel do sistema: parser, laudo, fila, API e
 * camada conversacional dependem SO daqui. A implementacao em motor.ts pode
 * ser reescrita inteira pelo contador/tributarista sem que nada mais mude.
 */

export type Recomendacao = 'dentro_das' | 'fora_das';
export type Confianca = 'alta' | 'media' | 'baixa';

/** Anexos do Simples Nacional (LC 123/2006). */
export type AnexoSimples = 'I' | 'II' | 'III' | 'IV' | 'V';

export interface ComposicaoReceita {
  /** % do faturamento vendido para outras empresas (clientes que tomam credito). */
  percentualB2B: number;
  /** % do faturamento vendido para consumidor final (nao aproveita credito). */
  percentualB2C: number;
}

export interface ParametrosSimulacao {
  cnpj: string;
  anexoSimples: string;
  faturamentoBrutoAnual: number;
  composicaoReceita: ComposicaoReceita;
  /** Para qual ano da transicao (2026...2033) esta simulando. */
  ano: number;

  // --- Campos opcionais: melhoram a precisao e a confianca do resultado. ---
  /** Folha de salarios dos ultimos 12 meses — entra no Fator R (Anexos III/V). */
  folhaSalarios12m?: number;
  /** Compras/insumos anuais que gerariam credito de IBS/CBS fora do DAS. */
  comprasComCredito?: number;
  /** UF — regras estaduais de ICMS ainda nao sao consideradas (ver observacoes). */
  uf?: string;
}

export interface ResultadoSimulacaoAno {
  ano: number;
  cargaTributariaDentroDAS: number;
  cargaTributariaForaDAS: number;
  /** cargaTributariaForaDAS - cargaTributariaDentroDAS. Negativo favorece sair. */
  diferenca: number;
}

/**
 * Linha da memoria de calculo. Sem isto o laudo e uma caixa-preta — e um
 * contador nao assina caixa-preta. Cada numero do resultado precisa poder ser
 * reconstruido a partir daqui.
 */
export interface LinhaMemoriaCalculo {
  ano: number;
  cenario: 'dentro_das' | 'fora_das';
  rubrica: string;
  valor: number;
  formula: string;
}

export interface ResultadoSimulacao {
  cnpj: string;
  /** ex: '2026-09' */
  cicloDecisao: string;
  recomendacao: Recomendacao;
  /** 'baixa' sempre que faltarem dados de entrada ou o motor nao for validado. */
  confianca: Confianca;
  projecaoPorAno: ResultadoSimulacaoAno[];
  /** ex: "calculo nao considera regras estaduais especificas de ICMS" */
  observacoes: string[];

  // --- Rastreabilidade: quem/o que produziu este numero. ---
  /** Versao do motor + versao do arquivo de parametros. */
  versaoMotor: string;
  /** false enquanto as regras nao forem revisadas por contador/tributarista. */
  validadoPorProfissional: boolean;
  memoriaCalculo: LinhaMemoriaCalculo[];
  /** Data-base do calculo (vai no laudo). */
  calculadoEm: string;
}

export interface MotorSimulacao {
  simular(params: ParametrosSimulacao): Promise<ResultadoSimulacao>;
}

/**
 * Assinatura exigida pela secao 6. A implementacao viva esta em motor.ts.
 */
export type FuncaoSimular = (
  params: ParametrosSimulacao,
) => Promise<ResultadoSimulacao>;
