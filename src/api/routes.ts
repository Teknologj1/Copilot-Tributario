import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { autenticar, assinaturaWebhookValida } from './autenticacao';
import { tratarMensagem, type MensagemWhatsapp } from '../intake/handler';
import { listarPorStatus, listarPendentes } from '../triagem';
import { simulacoes, empresas } from '../db/repositorios';
import * as auditoria from '../db/auditoria';
import { obterArmazenamento } from '../armazenamento';
import { simular } from '../simulacao/motor';
import { anualizarFaturamento } from '../parser';
import { ErroDominio, ErroNaoAutorizado, ErroNaoEncontrado, ErroValidacao } from '../comum/erros';
import { log } from '../comum/log';

/**
 * Endpoints da secao 7.
 *
 *   POST /webhook/whatsapp
 *   POST /api/simulacoes
 *   GET  /api/simulacoes/:id
 *   GET  /api/escritorios/:id/empresas?status=pendente
 *   GET  /api/simulacoes/:id/laudo.pdf
 */

const esquemaWebhook = z.object({
  de: z.string().min(1),
  texto: z.string().optional(),
  mensagemId: z.string().optional(),
  anexo: z
    .object({
      nomeArquivo: z.string(),
      tipoConteudo: z.string(),
      conteudoBase64: z.string(),
    })
    .optional(),
});

const esquemaSimulacao = z.object({
  empresaId: z.string().uuid(),
  dadosFiscaisExtraidos: z.object({
    cnpj: z.string(),
    periodo: z.string().optional(),
    faturamentoBruto: z.number().positive(),
    anexoSimples: z.string(),
    composicaoReceita: z.object({
      percentualB2B: z.number().min(0).max(100),
      percentualB2C: z.number().min(0).max(100),
    }),
    mesesCobertos: z.number().int().positive().optional(),
    folhaSalarios12m: z.number().nonnegative().optional(),
    comprasComCredito: z.number().nonnegative().optional(),
    uf: z.string().optional(),
  }),
  anos: z.array(z.number().int()).optional(),
});

export async function registrarRotas(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------------
  // Webhook do DisparaIA
  // ------------------------------------------------------------------
  app.post('/webhook/whatsapp', async (req: FastifyRequest, reply: FastifyReply) => {
    const bruto = (req as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const assinatura = req.headers['x-disparaia-signature'] as string | undefined;

    if (!assinaturaWebhookValida(bruto, assinatura)) {
      log.warn('Webhook com assinatura invalida rejeitado');
      throw new ErroNaoAutorizado('Assinatura do webhook invalida.');
    }

    const corpo = esquemaWebhook.parse(req.body);

    const mensagem: MensagemWhatsapp = {
      de: corpo.de,
      texto: corpo.texto,
      mensagemId: corpo.mensagemId,
      anexo: corpo.anexo
        ? {
            nomeArquivo: corpo.anexo.nomeArquivo,
            tipoConteudo: corpo.anexo.tipoConteudo,
            conteudo: Buffer.from(corpo.anexo.conteudoBase64, 'base64'),
          }
        : undefined,
    };

    const resultado = await tratarMensagem(mensagem);

    // 200 sempre que a mensagem foi aceita: o DisparaIA nao deve reentregar
    // por causa de erro de negocio nosso.
    return reply.code(200).send({
      recebido: true,
      enfileirado: resultado.enfileirado,
      duplicada: resultado.duplicada,
    });
  });

  // ------------------------------------------------------------------
  // Simulacao sob demanda (uso interno / fila)
  // ------------------------------------------------------------------
  app.post('/api/simulacoes', async (req: FastifyRequest, reply: FastifyReply) => {
    const escritorio = await autenticar(req);
    const corpo = esquemaSimulacao.parse(req.body);

    const empresa = await empresas.porId(corpo.empresaId);
    if (!empresa || empresa.escritorio_id !== escritorio.id) {
      throw new ErroNaoEncontrado('Empresa');
    }

    const dados = corpo.dadosFiscaisExtraidos;
    const faturamentoAnual = anualizarFaturamento({
      faturamentoBruto: dados.faturamentoBruto,
      mesesCobertos: dados.mesesCobertos ?? 12,
    } as never);

    const resultado = await simular(
      {
        cnpj: dados.cnpj,
        anexoSimples: dados.anexoSimples,
        faturamentoBrutoAnual: faturamentoAnual,
        composicaoReceita: dados.composicaoReceita,
        ano: new Date().getUTCFullYear(),
        folhaSalarios12m: dados.folhaSalarios12m,
        comprasComCredito: dados.comprasComCredito,
        uf: dados.uf ?? empresa.uf ?? undefined,
      },
      corpo.anos ? { anos: corpo.anos } : {},
    );

    const simulacao = await simulacoes.criar({
      empresaId: empresa.id,
      ciclo: resultado.cicloDecisao,
      dadosEntrada: { ...dados, origem: 'xml_nfe' } as never,
      resultado,
    });

    await auditoria.registrar({
      escritorioId: escritorio.id,
      ator: `api:${escritorio.id}`,
      acao: 'simulacao.criada',
      entidade: 'simulacoes',
      entidadeId: simulacao.id,
      detalhe: { recomendacao: resultado.recomendacao, confianca: resultado.confianca },
    });

    return reply.code(201).send({ id: simulacao.id, resultado });
  });

  // ------------------------------------------------------------------
  // Consulta de simulacao
  // ------------------------------------------------------------------
  app.get('/api/simulacoes/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const escritorio = await autenticar(req);
    const { id } = req.params as { id: string };

    const simulacao = await simulacoes.porIdDoEscritorio(id, escritorio.id);
    if (!simulacao) throw new ErroNaoEncontrado('Simulacao');

    return reply.send({
      id: simulacao.id,
      empresaId: simulacao.empresaId,
      ciclo: simulacao.ciclo,
      recomendacao: simulacao.recomendacao,
      confianca: simulacao.confianca,
      motorVersao: simulacao.motorVersao,
      criadoEm: simulacao.criadoEm,
      resultado: simulacao.resultado,
      laudoDisponivel: Boolean(simulacao.laudoPdfUrl),
    });
  });

  // ------------------------------------------------------------------
  // Triagem de portfolio
  // ------------------------------------------------------------------
  app.get('/api/escritorios/:id/empresas', async (req: FastifyRequest, reply: FastifyReply) => {
    const escritorio = await autenticar(req);
    const { id } = req.params as { id: string };

    // Uma API key so enxerga o proprio escritorio.
    if (id !== escritorio.id) throw new ErroNaoAutorizado('API key nao pertence a este escritorio.');

    const { status } = req.query as { status?: string };

    if (status && !['pendente', 'simulado', 'decidido'].includes(status)) {
      throw new ErroValidacao(`status invalido: ${status}`);
    }

    const itens = status
      ? await listarPorStatus(escritorio.id, status as 'pendente')
      : await listarPendentes(escritorio.id);

    await auditoria.registrar({
      escritorioId: escritorio.id,
      ator: `api:${escritorio.id}`,
      acao: 'triagem.consultada',
      detalhe: { status: status ?? 'pendente', total: itens.length },
    });

    return reply.send({ total: itens.length, empresas: itens });
  });

  // ------------------------------------------------------------------
  // Download do laudo
  // ------------------------------------------------------------------
  app.get('/api/simulacoes/:id/laudo.pdf', async (req: FastifyRequest, reply: FastifyReply) => {
    const escritorio = await autenticar(req);
    const { id } = req.params as { id: string };

    const simulacao = await simulacoes.porIdDoEscritorio(id, escritorio.id);
    if (!simulacao) throw new ErroNaoEncontrado('Simulacao');
    if (!simulacao.laudoPdfUrl) throw new ErroNaoEncontrado('Laudo');

    const pdf = await obterArmazenamento().obter(simulacao.laudoPdfUrl);

    await auditoria.registrar({
      escritorioId: escritorio.id,
      ator: `api:${escritorio.id}`,
      acao: 'laudo.baixado',
      entidade: 'simulacoes',
      entidadeId: simulacao.id,
    });

    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="laudo-${simulacao.id}.pdf"`)
      .send(pdf);
  });

  // ------------------------------------------------------------------
  // Saude
  // ------------------------------------------------------------------
  app.get('/saude', async (_req, reply) => reply.send({ ok: true }));
}

/** Tradutor de erro -> resposta HTTP, sem vazar stack nem dado fiscal. */
export function tratadorDeErros(
  erro: Error & { statusCode?: number; validation?: unknown },
  req: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (erro instanceof ErroDominio) {
    return reply.code(erro.status).send({
      erro: erro.codigo,
      mensagem: erro.message,
      ...(erro.detalhes ? { detalhes: erro.detalhes } : {}),
    });
  }

  if (erro instanceof z.ZodError) {
    return reply.code(400).send({
      erro: 'validacao',
      mensagem: 'Corpo da requisicao invalido.',
      detalhes: erro.issues.map((i) => ({ campo: i.path.join('.'), problema: i.message })),
    });
  }

  log.error('Erro nao tratado', { rota: req.url, erro: erro.message });

  return reply.code(erro.statusCode ?? 500).send({
    erro: 'interno',
    mensagem: 'Erro interno. A equipe foi notificada.',
  });
}
