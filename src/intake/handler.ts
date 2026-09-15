import { enfileirar } from '../fila/fila';
import { obterArmazenamento, chaveArquivoFiscal } from '../armazenamento';
import { obterClienteWhatsapp } from './disparaia';
import { escritorios, empresas, mensagens, conversas, simulacoes } from '../db/repositorios';
import * as auditoria from '../db/auditoria';
import { listarPendentes, formatarParaWhatsapp } from '../triagem';
import { camposFaltantes } from '../parser';
import { formatarCnpj, cnpjValido, normalizarCnpj } from '../comum/cnpj';
import { log } from '../comum/log';
import {
  CONVERSA_INICIAL,
  TEXTO_AJUDA,
  interpretar,
  interpretarAnexo,
  interpretarValor,
  proximaPendencia,
  resolverPendencia,
  type Conversa,
  type ContextoConversa,
  type Estado,
} from './maquinaEstados';
import type { DadosProcessarMensagem } from '../fila/processadores';

/**
 * Handler de mensagens do WhatsApp — secao 5.3.
 *
 * Entra a mensagem ja normalizada pelo DisparaIA, sai a resposta. Trabalho
 * pesado (parse, simulacao, laudo) vai para a fila; aqui so acontece o que
 * cabe dentro de um webhook.
 */

export interface AnexoRecebido {
  nomeArquivo: string;
  tipoConteudo: string;
  conteudo: Buffer;
}

export interface MensagemWhatsapp {
  /** Numero do contador (remetente). */
  de: string;
  texto?: string;
  anexo?: AnexoRecebido;
  /** Id da mensagem no DisparaIA — base da idempotencia. */
  mensagemId?: string;
}

export interface RespostaHandler {
  /** Texto enviado ao contador, quando houve resposta sincrona. */
  resposta?: string;
  /** true quando um trabalho foi enfileirado. */
  enfileirado: boolean;
  /** true quando a mensagem era repetida e foi ignorada. */
  duplicada: boolean;
}

function pareceXml(anexo: AnexoRecebido): boolean {
  if (/\.xml$/i.test(anexo.nomeArquivo)) return true;
  if (/xml/i.test(anexo.tipoConteudo)) return true;
  return anexo.conteudo.subarray(0, 512).toString('utf8').trimStart().startsWith('<');
}

async function carregarConversa(escritorioId: string): Promise<Conversa> {
  const linha = await conversas.obter(escritorioId);
  if (!linha) return CONVERSA_INICIAL;
  return {
    estado: linha.estado as Estado,
    contexto: (linha.contexto ?? {}) as ContextoConversa,
  };
}

async function responder(numero: string, texto: string): Promise<RespostaHandler> {
  await obterClienteWhatsapp().enviarTexto(numero, texto);
  return { resposta: texto, enfileirado: false, duplicada: false };
}

/**
 * Ponto de entrada unico do intake. O escritorio e identificado pelo numero
 * cadastrado — numero desconhecido nao entra no fluxo (e a fronteira de
 * multi-tenant do piloto).
 */
export async function tratarMensagem(msg: MensagemWhatsapp): Promise<RespostaHandler> {
  const escritorio = await escritorios.porWhatsapp(msg.de);

  if (!escritorio) {
    log.warn('Mensagem de numero nao cadastrado', { numero: msg.de });
    return responder(
      msg.de,
      'Nao encontrei um escritorio cadastrado para este numero. Fale com o time do ' +
        'Copiloto da Reforma para liberar seu acesso ao piloto.',
    );
  }

  // Registro + idempotencia: reentrega do webhook nao reprocessa.
  const { mensagem, jaExistia } = await mensagens.registrar({
    escritorioId: escritorio.id,
    tipoAnexo: msg.anexo ? 'xml_nfe' : 'texto',
    conteudoBruto: msg.anexo ? null : (msg.texto ?? null),
    origemMensagemId: msg.mensagemId ?? null,
  });

  if (jaExistia) {
    log.info('Mensagem duplicada ignorada', { mensagemId: mensagem.id });
    return { enfileirado: false, duplicada: true };
  }

  await auditoria.registrar({
    escritorioId: escritorio.id,
    ator: msg.de,
    acao: 'mensagem.recebida',
    entidade: 'mensagens_recebidas',
    entidadeId: mensagem.id,
    detalhe: { comAnexo: Boolean(msg.anexo) },
  });

  const conversa = await carregarConversa(escritorio.id);

  // Anexo tem prioridade sobre qualquer estado: mandar um XML novo sempre
  // recomeca o atendimento para aquela empresa.
  if (msg.anexo) {
    return tratarAnexo(escritorio.id, msg, mensagem.id);
  }

  const comando = interpretar(msg.texto ?? '');

  if (comando.tipo === 'cancelar') {
    await conversas.salvar(escritorio.id, 'ocioso', {});
    await mensagens.atualizarStatus(mensagem.id, 'processada');
    return responder(msg.de, 'Atendimento cancelado. Quando quiser, e so mandar o XML ou *simular [CNPJ]*.');
  }

  if (comando.tipo === 'pendentes') {
    const itens = await listarPendentes(escritorio.id);
    await auditoria.registrar({
      escritorioId: escritorio.id,
      ator: msg.de,
      acao: 'triagem.consultada',
      detalhe: { total: itens.length },
    });
    await mensagens.atualizarStatus(mensagem.id, 'processada');
    return responder(msg.de, formatarParaWhatsapp(itens));
  }

  // Estamos no meio de uma coleta de campos: a mensagem e a resposta a pergunta.
  if (conversa.estado === 'confirmando_campos') {
    return tratarResposta(escritorio.id, msg, mensagem.id, conversa);
  }

  if (comando.tipo === 'simular') {
    return tratarSimular(escritorio.id, msg, mensagem.id, comando.cnpj);
  }

  await mensagens.atualizarStatus(mensagem.id, 'processada');
  return responder(msg.de, TEXTO_AJUDA);
}

// --------------------------------------------------------------------------

async function tratarAnexo(
  escritorioId: string,
  msg: MensagemWhatsapp,
  mensagemId: string,
): Promise<RespostaHandler> {
  const anexo = msg.anexo as AnexoRecebido;

  if (!pareceXml(anexo)) {
    await mensagens.atualizarStatus(mensagemId, 'erro', 'anexo nao e XML');
    return responder(
      msg.de,
      'Por enquanto eu leio apenas o *XML* das notas fiscais. PGDAS e SPED entram ' +
        'em uma proxima versao.\n\nSe preferir, me diga os dados por aqui: envie ' +
        '*simular [CNPJ]* e eu pergunto o que preciso.',
    );
  }

  const chave = chaveArquivoFiscal(escritorioId, 'xml');
  await obterArmazenamento().salvar(chave, anexo.conteudo, 'application/xml');
  await mensagens.atualizarStatus(mensagemId, 'recebida');

  await conversas.salvar(escritorioId, 'processando', { mensagemId, chaveArquivo: chave });

  const trabalho: DadosProcessarMensagem = {
    mensagemId,
    escritorioId,
    numeroWhatsapp: msg.de,
    chaveArquivo: chave,
  };

  await obterClienteWhatsapp().enviarTexto(
    msg.de,
    'Recebi o arquivo ✅ Estou lendo as notas e rodando a simulacao. ' +
      'Te mando o resultado com o laudo em PDF em instantes.',
  );

  await enfileirar('processar-mensagem', trabalho);

  return { enfileirado: true, duplicada: false };
}

async function tratarSimular(
  escritorioId: string,
  msg: MensagemWhatsapp,
  mensagemId: string,
  cnpj?: string,
): Promise<RespostaHandler> {
  if (!cnpj) {
    await conversas.salvar(escritorioId, 'aguardando_dados', {});
    await mensagens.atualizarStatus(mensagemId, 'processada');
    return responder(
      msg.de,
      'Qual empresa voce quer simular? Envie *simular* seguido do CNPJ ' +
        '(ex: simular 12.345.678/0001-95), ou mande o XML das notas dela.',
    );
  }

  if (!cnpjValido(cnpj)) {
    await mensagens.atualizarStatus(mensagemId, 'processada');
    return responder(
      msg.de,
      `O CNPJ ${formatarCnpj(cnpj)} nao parece valido (os digitos verificadores nao batem). ` +
        'Pode conferir e mandar de novo?',
    );
  }

  const empresa = await empresas.porCnpj(escritorioId, cnpj);

  if (!empresa) {
    await conversas.salvar(escritorioId, 'aguardando_dados', { cnpj: normalizarCnpj(cnpj) });
    await mensagens.atualizarStatus(mensagemId, 'processada');
    return responder(
      msg.de,
      `Ainda nao tenho dados fiscais de ${formatarCnpj(cnpj)}. ` +
        'Me envie o *XML das notas fiscais* dessa empresa que eu simulo na hora.',
    );
  }

  // Empresa conhecida: reaproveita o ultimo conjunto de dados fiscais.
  const ultima = await simulacoes.ultimaDaEmpresa(empresa.id);

  if (!ultima) {
    await conversas.salvar(escritorioId, 'aguardando_dados', {
      cnpj: empresa.cnpj,
      empresaId: empresa.id,
    });
    await mensagens.atualizarStatus(mensagemId, 'processada');
    return responder(
      msg.de,
      `${empresa.razao_social} esta cadastrada, mas ainda nao tenho as notas dela. ` +
        'Me envie o XML do periodo que eu simulo.',
    );
  }

  await conversas.salvar(escritorioId, 'processando', {
    cnpj: empresa.cnpj,
    empresaId: empresa.id,
  });

  const trabalho: DadosProcessarMensagem = {
    mensagemId,
    escritorioId,
    numeroWhatsapp: msg.de,
    chaveArquivo: ultima.dadosEntrada.chaveArquivo ?? '',
    cnpjAlvo: empresa.cnpj,
  };

  if (!trabalho.chaveArquivo) {
    await mensagens.atualizarStatus(mensagemId, 'processada');
    return responder(
      msg.de,
      `Os dados fiscais de ${empresa.razao_social} ja foram expurgados pela politica de ` +
        'retencao. Me envie o XML novamente para uma nova simulacao.',
    );
  }

  await obterClienteWhatsapp().enviarTexto(
    msg.de,
    `Rodando nova simulacao para *${empresa.razao_social}*. Ja te mando o laudo.`,
  );

  await enfileirar('processar-mensagem', trabalho);
  return { enfileirado: true, duplicada: false };
}

/**
 * Coleta guiada: uma pergunta por vez, e a resposta so avanca quando foi
 * entendida. Resposta ambigua repete a pergunta em vez de assumir um valor.
 */
async function tratarResposta(
  escritorioId: string,
  msg: MensagemWhatsapp,
  mensagemId: string,
  conversa: Conversa,
): Promise<RespostaHandler> {
  const pendencia = proximaPendencia(conversa.contexto);
  const texto = msg.texto ?? '';
  const comando = interpretar(texto);

  if (!pendencia) {
    await conversas.salvar(escritorioId, 'ocioso', {});
    await mensagens.atualizarStatus(mensagemId, 'processada');
    return responder(msg.de, TEXTO_AJUDA);
  }

  let contexto = conversa.contexto;
  const dados = { ...(contexto.dadosParciais ?? {}) } as Record<string, unknown>;

  const pulados = [...(contexto.pulados ?? [])];

  if (comando.tipo === 'pular') {
    if (pendencia.obrigatorio) {
      await mensagens.atualizarStatus(mensagemId, 'processada');
      return responder(
        msg.de,
        `Esse campo eu nao consigo dispensar — sem ele a simulacao nao sai.\n\n${pendencia.pergunta}`,
      );
    }
    pulados.push(pendencia.campo);
    contexto = resolverPendencia(contexto, pendencia.campo);
  } else {
    const valor =
      pendencia.campo === 'anexoSimples'
        ? interpretarAnexo(texto)
        : interpretarValor(texto);

    if (valor === null) {
      await mensagens.atualizarStatus(mensagemId, 'processada');
      return responder(
        msg.de,
        `Nao consegui entender "${texto.slice(0, 40)}".\n\n${pendencia.pergunta}`,
      );
    }

    dados[pendencia.campo] = valor;
    contexto = resolverPendencia({ ...contexto, dadosParciais: dados as never }, pendencia.campo);
  }

  // Recalcula do zero a partir do estado atual dos dados: responder o anexo
  // pode fazer aparecer uma pergunta que antes nem existia (a folha so importa
  // depois de saber que o anexo e III ou V). Campos dispensados nao voltam.
  const restantes = camposFaltantes(dados as never).filter((c) => !pulados.includes(c.campo));
  contexto = { ...contexto, pendencias: restantes, pulados };

  const proxima = proximaPendencia(contexto);

  if (proxima) {
    await conversas.salvar(escritorioId, 'confirmando_campos', contexto as Record<string, unknown>);
    await mensagens.atualizarStatus(mensagemId, 'processada');
    return responder(msg.de, proxima.pergunta);
  }

  // Nada mais a perguntar: volta para a fila.
  await conversas.salvar(escritorioId, 'processando', contexto as Record<string, unknown>);

  const trabalho: DadosProcessarMensagem = {
    mensagemId,
    escritorioId,
    numeroWhatsapp: msg.de,
    chaveArquivo: contexto.chaveArquivo ?? '',
    cnpjAlvo: contexto.cnpj,
    complementos: {
      anexoSimples: dados.anexoSimples as string | undefined,
      folhaSalarios12m: dados.folhaSalarios12m as number | undefined,
      comprasComCredito: dados.comprasComCredito as number | undefined,
    },
  };

  await obterClienteWhatsapp().enviarTexto(msg.de, 'Perfeito. Rodando a simulacao agora ⏳');
  await enfileirar('processar-mensagem', trabalho);

  return { enfileirado: true, duplicada: false };
}
