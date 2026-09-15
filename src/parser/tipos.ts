/** Tipos do parser fiscal — secao 5.1 da especificacao. */

export type TipoArquivoFiscal = 'xml_nfe' | 'pgdas' | 'sped';

export interface DadosFiscaisExtraidos {
  cnpj: string;
  /** AAAA-MM — mes mais recente coberto pelos documentos lidos. */
  periodo: string;
  /** Soma das saidas no periodo coberto (NAO anualizado — ver mesesCobertos). */
  faturamentoBruto: number;
  anexoSimples?: string;
  composicaoReceita: {
    percentualB2B: number;
    percentualB2C: number;
  };

  // --- Complementos uteis ao restante do pipeline ---
  razaoSocial?: string;
  uf?: string;
  /** Quantos meses distintos os documentos cobrem. Base para anualizar. */
  mesesCobertos: number;
  /** Meses encontrados, em ordem (AAAA-MM). */
  periodos: string[];
  /** Quantidade de documentos de saida efetivamente considerados. */
  documentosProcessados: number;
  /**
   * Codigo de Regime Tributario do emitente (CRT da NF-e):
   * 1 = Simples Nacional, 2 = Simples (excesso de sublimite), 3 = Regime Normal.
   */
  regimeTributarioDeclarado?: number;
  /** Informado pelo contador, nao extraido do XML. */
  folhaSalarios12m?: number;
  /** Informado pelo contador, nao extraido do XML. */
  comprasComCredito?: number;
  /** Origem dos dados, para o laudo e a auditoria. */
  origem: TipoArquivoFiscal;
  /**
   * Chave do arquivo bruto no armazenamento. Guardada junto com a simulacao
   * para permitir re-simular a mesma empresa sem pedir o XML de novo — ate a
   * politica de retencao (secao 8) apagar o arquivo.
   */
  chaveArquivo?: string;
  /** Ressalvas do parser: o que ele nao conseguiu determinar com seguranca. */
  avisos: string[];
}

/** Campo que a simulacao precisa e o parser nao conseguiu extrair sozinho. */
export interface CampoFaltante {
  campo: string;
  /** Pergunta pronta para ser enviada ao contador no WhatsApp. */
  pergunta: string;
  obrigatorio: boolean;
}
