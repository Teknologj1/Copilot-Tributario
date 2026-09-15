import { query } from './index';
import { log } from '../comum/log';

/**
 * Log de auditoria (secao 8): quem simulou o que e quando.
 *
 * A tabela e append-only por trigger no banco — nem a aplicacao consegue
 * apagar. Falha ao auditar nao derruba a operacao principal, mas vai para o
 * log de erro com destaque: auditoria silenciosamente quebrada e pior do que
 * auditoria ausente.
 */

export type AcaoAuditavel =
  | 'mensagem.recebida'
  | 'simulacao.criada'
  | 'simulacao.falhou'
  | 'laudo.gerado'
  | 'laudo.baixado'
  | 'laudo.enviado'
  | 'triagem.consultada'
  | 'retencao.expurgo';

export interface EntradaAuditoria {
  escritorioId: string | null;
  /** Numero de WhatsApp, identificador da API key, ou 'sistema'. */
  ator: string;
  acao: AcaoAuditavel;
  entidade?: string;
  entidadeId?: string;
  detalhe?: Record<string, unknown>;
}

export async function registrar(entrada: EntradaAuditoria): Promise<void> {
  try {
    await query(
      `INSERT INTO auditoria (escritorio_id, ator, acao, entidade, entidade_id, detalhe)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entrada.escritorioId,
        entrada.ator,
        entrada.acao,
        entrada.entidade ?? null,
        entrada.entidadeId ?? null,
        JSON.stringify(entrada.detalhe ?? {}),
      ],
    );
  } catch (erro) {
    log.error('FALHA AO GRAVAR AUDITORIA', {
      acao: entrada.acao,
      erro: (erro as Error).message,
    });
  }
}
