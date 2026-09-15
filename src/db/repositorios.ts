import { query, queryUm, transacao, type PoolClient } from './index';
import { cifrar, decifrar, ehEnvelopeCifrado, hashApiKey } from '../seguranca/cripto';
import { normalizarCnpj } from '../comum/cnpj';
import { ErroNaoEncontrado } from '../comum/erros';
import type { ResultadoSimulacao } from '../simulacao/interface';
import type { DadosFiscaisExtraidos } from '../parser/tipos';

/**
 * Acesso a dados por entidade.
 *
 * REGRA CENTRAL DESTE ARQUIVO (secao 8): dados fiscais de terceiros — o que
 * entra em simulacoes.dados_entrada e simulacoes.resultado — passam por
 * cifrar() na escrita e decifrar() na leitura. O banco nunca ve o JSON em
 * claro. Se alguem adicionar um caminho de escrita novo aqui, tem que passar
 * por cifrar() tambem.
 */

// --------------------------------------------------------------------------
// Escritorios
// --------------------------------------------------------------------------

export interface Escritorio {
  id: string;
  nome: string;
  cnpj: string;
  whatsapp_numero: string;
  plano: string;
  criado_em: Date;
}

export const escritorios = {
  async porId(id: string): Promise<Escritorio | null> {
    return queryUm<Escritorio>(
      'SELECT id, nome, cnpj, whatsapp_numero, plano, criado_em FROM escritorios WHERE id = $1',
      [id],
    );
  },

  async porWhatsapp(numero: string): Promise<Escritorio | null> {
    return queryUm<Escritorio>(
      'SELECT id, nome, cnpj, whatsapp_numero, plano, criado_em FROM escritorios WHERE whatsapp_numero = $1',
      [numero],
    );
  },

  /** Autenticacao da API (secao 7): busca pelo hash, nunca pela chave em claro. */
  async porApiKey(chave: string): Promise<Escritorio | null> {
    return queryUm<Escritorio>(
      'SELECT id, nome, cnpj, whatsapp_numero, plano, criado_em FROM escritorios WHERE api_key_hash = $1',
      [hashApiKey(chave)],
    );
  },

  async criar(dados: {
    nome: string;
    cnpj: string;
    whatsappNumero: string;
    plano?: string;
    apiKeyHash?: string;
  }): Promise<Escritorio> {
    const linha = await queryUm<Escritorio>(
      `INSERT INTO escritorios (nome, cnpj, whatsapp_numero, plano, api_key_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, nome, cnpj, whatsapp_numero, plano, criado_em`,
      [
        dados.nome,
        normalizarCnpj(dados.cnpj),
        dados.whatsappNumero,
        dados.plano ?? 'piloto',
        dados.apiKeyHash ?? null,
      ],
    );
    return linha as Escritorio;
  },

  async definirApiKeyHash(id: string, hash: string): Promise<void> {
    await query('UPDATE escritorios SET api_key_hash = $2 WHERE id = $1', [id, hash]);
  },
};

// --------------------------------------------------------------------------
// Empresas-cliente
// --------------------------------------------------------------------------

export type StatusDecisao = 'pendente' | 'simulado' | 'decidido';

export interface EmpresaCliente {
  id: string;
  escritorio_id: string;
  razao_social: string;
  cnpj: string;
  anexo_simples: string | null;
  uf: string | null;
  status_decisao: StatusDecisao;
  prazo_decisao: Date | null;
  criado_em: Date;
}

const COLUNAS_EMPRESA = `id, escritorio_id, razao_social, cnpj, anexo_simples, uf,
                         status_decisao, prazo_decisao, criado_em`;

export const empresas = {
  async porId(id: string): Promise<EmpresaCliente | null> {
    return queryUm<EmpresaCliente>(
      `SELECT ${COLUNAS_EMPRESA} FROM empresas_cliente WHERE id = $1`,
      [id],
    );
  },

  async porCnpj(escritorioId: string, cnpj: string): Promise<EmpresaCliente | null> {
    return queryUm<EmpresaCliente>(
      `SELECT ${COLUNAS_EMPRESA} FROM empresas_cliente
       WHERE escritorio_id = $1 AND cnpj = $2`,
      [escritorioId, normalizarCnpj(cnpj)],
    );
  },

  async pendentes(escritorioId: string): Promise<EmpresaCliente[]> {
    // Ordenado por proximidade do prazo (5.5). NULLS LAST: empresa sem prazo
    // definido nao pode empurrar para o topo quem ja tem data marcada.
    return query<EmpresaCliente>(
      `SELECT ${COLUNAS_EMPRESA} FROM empresas_cliente
       WHERE escritorio_id = $1 AND status_decisao = 'pendente'
       ORDER BY prazo_decisao ASC NULLS LAST, criado_em ASC`,
      [escritorioId],
    );
  },

  async porStatus(escritorioId: string, status: StatusDecisao): Promise<EmpresaCliente[]> {
    return query<EmpresaCliente>(
      `SELECT ${COLUNAS_EMPRESA} FROM empresas_cliente
       WHERE escritorio_id = $1 AND status_decisao = $2
       ORDER BY prazo_decisao ASC NULLS LAST, criado_em ASC`,
      [escritorioId, status],
    );
  },

  async listar(escritorioId: string): Promise<EmpresaCliente[]> {
    return query<EmpresaCliente>(
      `SELECT ${COLUNAS_EMPRESA} FROM empresas_cliente
       WHERE escritorio_id = $1
       ORDER BY prazo_decisao ASC NULLS LAST, razao_social ASC`,
      [escritorioId],
    );
  },

  /**
   * Cria ou recupera a empresa. O intake descobre CNPJs novos a partir do XML,
   * entao precisa ser idempotente por (escritorio_id, cnpj).
   */
  async garantir(dados: {
    escritorioId: string;
    cnpj: string;
    razaoSocial: string;
    anexoSimples?: string | null;
    uf?: string | null;
    prazoDecisao?: Date | null;
  }): Promise<EmpresaCliente> {
    const cnpj = normalizarCnpj(dados.cnpj);
    const linha = await queryUm<EmpresaCliente>(
      `INSERT INTO empresas_cliente
         (escritorio_id, cnpj, razao_social, anexo_simples, uf, prazo_decisao)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (escritorio_id, cnpj) DO UPDATE SET
         razao_social  = COALESCE(NULLIF(EXCLUDED.razao_social, ''), empresas_cliente.razao_social),
         anexo_simples = COALESCE(EXCLUDED.anexo_simples, empresas_cliente.anexo_simples),
         uf            = COALESCE(EXCLUDED.uf, empresas_cliente.uf),
         prazo_decisao = COALESCE(EXCLUDED.prazo_decisao, empresas_cliente.prazo_decisao)
       RETURNING ${COLUNAS_EMPRESA}`,
      [
        dados.escritorioId,
        cnpj,
        dados.razaoSocial,
        dados.anexoSimples ?? null,
        dados.uf ?? null,
        dados.prazoDecisao ?? null,
      ],
    );
    return linha as EmpresaCliente;
  },

  async atualizarStatus(
    id: string,
    status: StatusDecisao,
    cliente?: PoolClient,
  ): Promise<void> {
    const sql = 'UPDATE empresas_cliente SET status_decisao = $2 WHERE id = $1';
    if (cliente) await cliente.query(sql, [id, status]);
    else await query(sql, [id, status]);
  },
};

// --------------------------------------------------------------------------
// Simulacoes  — dados cifrados em repouso
// --------------------------------------------------------------------------

interface LinhaSimulacaoBruta {
  id: string;
  empresa_id: string;
  ciclo: string;
  dados_entrada: unknown;
  resultado: unknown;
  recomendacao: string;
  confianca: string;
  motor_versao: string;
  laudo_pdf_url: string | null;
  criado_em: Date;
}

export interface Simulacao {
  id: string;
  empresaId: string;
  ciclo: string;
  dadosEntrada: DadosFiscaisExtraidos;
  resultado: ResultadoSimulacao;
  recomendacao: string;
  confianca: string;
  motorVersao: string;
  laudoPdfUrl: string | null;
  criadoEm: Date;
}

/**
 * Decifra tolerando linhas legadas gravadas em claro (util em bancos de
 * desenvolvimento anteriores a criptografia). Em producao tudo deve estar
 * cifrado; o caminho em claro so existe para nao quebrar dev.
 */
function abrir<T>(valor: unknown): T {
  return ehEnvelopeCifrado(valor) ? decifrar<T>(valor) : (valor as T);
}

function materializar(linha: LinhaSimulacaoBruta): Simulacao {
  return {
    id: linha.id,
    empresaId: linha.empresa_id,
    ciclo: linha.ciclo,
    dadosEntrada: abrir<DadosFiscaisExtraidos>(linha.dados_entrada),
    resultado: abrir<ResultadoSimulacao>(linha.resultado),
    recomendacao: linha.recomendacao,
    confianca: linha.confianca,
    motorVersao: linha.motor_versao,
    laudoPdfUrl: linha.laudo_pdf_url,
    criadoEm: linha.criado_em,
  };
}

const COLUNAS_SIMULACAO = `id, empresa_id, ciclo, dados_entrada, resultado, recomendacao,
                           confianca, motor_versao, laudo_pdf_url, criado_em`;

export const simulacoes = {
  async porId(id: string): Promise<Simulacao | null> {
    const linha = await queryUm<LinhaSimulacaoBruta>(
      `SELECT ${COLUNAS_SIMULACAO} FROM simulacoes WHERE id = $1`,
      [id],
    );
    return linha ? materializar(linha) : null;
  },

  /**
   * Busca a simulacao garantindo que ela pertence ao escritorio informado.
   * Sem este join, uma API key valida leria o laudo de outro escritorio.
   */
  async porIdDoEscritorio(id: string, escritorioId: string): Promise<Simulacao | null> {
    const linha = await queryUm<LinhaSimulacaoBruta>(
      `SELECT s.id, s.empresa_id, s.ciclo, s.dados_entrada, s.resultado, s.recomendacao,
              s.confianca, s.motor_versao, s.laudo_pdf_url, s.criado_em
       FROM simulacoes s
       JOIN empresas_cliente e ON e.id = s.empresa_id
       WHERE s.id = $1 AND e.escritorio_id = $2`,
      [id, escritorioId],
    );
    return linha ? materializar(linha) : null;
  },

  async ultimaDaEmpresa(empresaId: string): Promise<Simulacao | null> {
    const linha = await queryUm<LinhaSimulacaoBruta>(
      `SELECT ${COLUNAS_SIMULACAO} FROM simulacoes
       WHERE empresa_id = $1 ORDER BY criado_em DESC LIMIT 1`,
      [empresaId],
    );
    return linha ? materializar(linha) : null;
  },

  /**
   * Grava a simulacao e move a empresa para 'simulado' na mesma transacao.
   * dados_entrada e resultado vao CIFRADOS.
   */
  async criar(dados: {
    empresaId: string;
    ciclo: string;
    dadosEntrada: DadosFiscaisExtraidos;
    resultado: ResultadoSimulacao;
  }): Promise<Simulacao> {
    return transacao(async (cliente) => {
      const res = await cliente.query<LinhaSimulacaoBruta>(
        `INSERT INTO simulacoes
           (empresa_id, ciclo, dados_entrada, resultado, recomendacao, confianca, motor_versao)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${COLUNAS_SIMULACAO}`,
        [
          dados.empresaId,
          dados.ciclo,
          JSON.stringify(cifrar(dados.dadosEntrada)),
          JSON.stringify(cifrar(dados.resultado)),
          dados.resultado.recomendacao,
          dados.resultado.confianca,
          dados.resultado.versaoMotor,
        ],
      );

      await empresas.atualizarStatus(dados.empresaId, 'simulado', cliente);

      return materializar(res.rows[0] as LinhaSimulacaoBruta);
    });
  },

  async definirLaudo(id: string, url: string): Promise<void> {
    await query('UPDATE simulacoes SET laudo_pdf_url = $2 WHERE id = $1', [id, url]);
  },

  /** Retencao (secao 8): limpa dados de entrada de simulacoes antigas. */
  async expurgarDadosEntradaAnterioresA(limite: Date): Promise<number> {
    const linhas = await query<{ id: string }>(
      `UPDATE simulacoes SET dados_entrada = '{"expurgado": true}'::jsonb
       WHERE criado_em < $1 AND dados_entrada->>'expurgado' IS NULL
       RETURNING id`,
      [limite],
    );
    return linhas.length;
  },
};

// --------------------------------------------------------------------------
// Mensagens recebidas
// --------------------------------------------------------------------------

export type StatusMensagem = 'recebida' | 'processando' | 'processada' | 'erro';
export type TipoAnexo = 'xml_nfe' | 'pgdas' | 'sped' | 'texto';

export interface MensagemRecebida {
  id: string;
  escritorio_id: string;
  tipo_anexo: TipoAnexo | null;
  conteudo_bruto: string | null;
  status: StatusMensagem;
  erro_detalhe: string | null;
  origem_mensagem_id: string | null;
  criado_em: Date;
}

export const mensagens = {
  async porId(id: string): Promise<MensagemRecebida | null> {
    return queryUm<MensagemRecebida>('SELECT * FROM mensagens_recebidas WHERE id = $1', [id]);
  },

  async porOrigem(escritorioId: string, origemId: string): Promise<MensagemRecebida | null> {
    return queryUm<MensagemRecebida>(
      'SELECT * FROM mensagens_recebidas WHERE escritorio_id = $1 AND origem_mensagem_id = $2',
      [escritorioId, origemId],
    );
  },

  /**
   * Registra a mensagem. Idempotente por origem_mensagem_id: uma reentrega do
   * webhook do DisparaIA devolve a linha existente em vez de duplicar o
   * processamento. `jaExistia` diz ao chamador que nao deve enfileirar de novo.
   */
  async registrar(dados: {
    escritorioId: string;
    tipoAnexo: TipoAnexo | null;
    conteudoBruto: string | null;
    origemMensagemId?: string | null;
  }): Promise<{ mensagem: MensagemRecebida; jaExistia: boolean }> {
    if (dados.origemMensagemId) {
      const existente = await this.porOrigem(dados.escritorioId, dados.origemMensagemId);
      if (existente) return { mensagem: existente, jaExistia: true };
    }

    const linha = await queryUm<MensagemRecebida>(
      `INSERT INTO mensagens_recebidas
         (escritorio_id, tipo_anexo, conteudo_bruto, origem_mensagem_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (escritorio_id, origem_mensagem_id)
         WHERE origem_mensagem_id IS NOT NULL
         DO NOTHING
       RETURNING *`,
      [
        dados.escritorioId,
        dados.tipoAnexo,
        dados.conteudoBruto,
        dados.origemMensagemId ?? null,
      ],
    );

    // DO NOTHING devolve zero linhas quando houve corrida entre dois webhooks.
    if (!linha) {
      const existente = await this.porOrigem(
        dados.escritorioId,
        dados.origemMensagemId as string,
      );
      if (!existente) throw new ErroNaoEncontrado('Mensagem');
      return { mensagem: existente, jaExistia: true };
    }

    return { mensagem: linha, jaExistia: false };
  },

  async atualizarStatus(
    id: string,
    status: StatusMensagem,
    erroDetalhe?: string,
  ): Promise<void> {
    await query(
      'UPDATE mensagens_recebidas SET status = $2, erro_detalhe = $3 WHERE id = $1',
      [id, status, erroDetalhe ?? null],
    );
  },

  async anterioresA(limite: Date): Promise<MensagemRecebida[]> {
    return query<MensagemRecebida>(
      `SELECT * FROM mensagens_recebidas
       WHERE criado_em < $1 AND conteudo_bruto IS NOT NULL AND status = 'processada'`,
      [limite],
    );
  },

  async limparConteudoBruto(id: string): Promise<void> {
    await query('UPDATE mensagens_recebidas SET conteudo_bruto = NULL WHERE id = $1', [id]);
  },
};

// --------------------------------------------------------------------------
// Conversas (state machine do WhatsApp)
// --------------------------------------------------------------------------

export interface LinhaConversa {
  escritorio_id: string;
  estado: string;
  contexto: Record<string, unknown>;
  atualizado_em: Date;
}

export const conversas = {
  async obter(escritorioId: string): Promise<LinhaConversa | null> {
    return queryUm<LinhaConversa>('SELECT * FROM conversas WHERE escritorio_id = $1', [
      escritorioId,
    ]);
  },

  async salvar(
    escritorioId: string,
    estado: string,
    contexto: Record<string, unknown>,
  ): Promise<void> {
    await query(
      `INSERT INTO conversas (escritorio_id, estado, contexto, atualizado_em)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (escritorio_id) DO UPDATE SET
         estado = EXCLUDED.estado,
         contexto = EXCLUDED.contexto,
         atualizado_em = now()`,
      [escritorioId, estado, JSON.stringify(contexto)],
    );
  },
};
