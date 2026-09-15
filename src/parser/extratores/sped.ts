import { ErroParser } from '../../comum/erros';
import type { DadosFiscaisExtraidos } from '../tipos';

/**
 * Extrator de SPED — FASE 2. Mesma decisao de escopo do PGDAS (secao 5.1).
 */
export async function extrairDeSped(_arquivo: Buffer): Promise<DadosFiscaisExtraidos> {
  throw new ErroParser(
    'Leitura de SPED ainda nao esta disponivel (prevista para a Fase 2). ' +
      'Envie o XML das notas fiscais do periodo, ou informe os dados pelo chat.',
    { tipo: 'sped', fase: 2 },
  );
}
