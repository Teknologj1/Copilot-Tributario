import { ErroParser } from '../../comum/erros';
import type { DadosFiscaisExtraidos } from '../tipos';

/**
 * Extrator de PGDAS — FASE 2.
 *
 * Decisao registrada na secao 5.1: o piloto aceita apenas XML de NF-e, para
 * nao travar o cronograma. O PGDAS costuma chegar como PDF, o que exigiria
 * extracao de texto e heuristica de leiaute — trabalho que so se justifica
 * depois do fluxo principal estar provado ponta a ponta.
 *
 * Enquanto isso, o fluxo conversacional pede ao contador os campos que o
 * PGDAS traria (anexo, faturamento acumulado, folha) — ver parser/index.ts,
 * funcao camposFaltantes().
 */
export async function extrairDePgdas(_arquivo: Buffer): Promise<DadosFiscaisExtraidos> {
  throw new ErroParser(
    'Leitura de PGDAS ainda nao esta disponivel (prevista para a Fase 2). ' +
      'Envie o XML das notas fiscais do periodo, ou informe os dados pelo chat.',
    { tipo: 'pgdas', fase: 2 },
  );
}
