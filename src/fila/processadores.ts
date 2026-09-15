import { registrarProcessador } from './fila';
import { obterArmazenamento, chaveLaudo } from '../armazenamento';
import { extrairDadosFiscais, anualizarFaturamento, camposFaltantes } from '../parser';
import { simular } from '../simulacao/motor';
import { gerarLaudo } from '../laudo';
import { montarResumo } from '../laudo/texto';
import { obterClienteWhatsapp } from '../intake/disparaia';
import { empresas, mensagens, simulacoes, conversas } from '../db/repositorios';
import * as auditoria from '../db/auditoria';
import { log } from '../comum/log';
import { ErroDominio } from '../comum/erros';
import { formatarCnpj } from '../comum/cnpj';
import type { DadosFiscaisExtraidos } from '../parser/tipos';
import type { ContextoConversa } from '../intake/maquinaEstados';

/**
 * Pipeline de processamento (secao 3): parse -> simulacao -> laudo -> registro
 * -> resposta no WhatsApp.
 *
 * Roda fora do webhook para nao segurar a resposta ao DisparaIA. Cada etapa
 * atualiza mensagens_recebidas.status, entao um travamento e diagnosticavel
 * pelo banco, sem depender de ler log.
 */

export interface DadosProcessarMensagem {
  mensagemId: string;
  escritorioId: string;
  numeroWhatsapp: string;
  /** Chave do XML no armazenamento. */
  chaveArquivo: string;
  /** Quando o contador disse qual empresa simular. */
  cnpjAlvo?: string;
  /** Campos que o parser nao extrai e o contador informou no chat. */
  complementos?: {
    anexoSimples?: string;
    folhaSalarios12m?: number;
    comprasComCredito?: number;
  };
}

function cicloAtual(data = new Date()): string {
  return `${data.getUTCFullYear()}-${String(data.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Junta o que veio do XML com o que o contador informou no chat. O chat vence:
 * quem esta na frente do cliente sabe mais do que o parser.
 */
function combinar(
  dados: DadosFiscaisExtraidos,
  complementos: DadosProcessarMensagem['complementos'],
): DadosFiscaisExtraidos {
  if (!complementos) return dados;
  return {
    ...dados,
    anexoSimples: complementos.anexoSimples ?? dados.anexoSimples,
    folhaSalarios12m: complementos.folhaSalarios12m ?? dados.folhaSalarios12m,
    comprasComCredito: complementos.comprasComCredito ?? dados.comprasComCredito,
  };
}

/**
 * Faltando algo obrigatorio, a conversa volta a perguntar em vez de simular
 * com chute. Devolve true quando o pipeline foi interrompido para perguntar.
 */
async function pedirComplementos(
  dados: DadosFiscaisExtraidos,
  trabalho: DadosProcessarMensagem,
): Promise<boolean> {
  // O pipeline so barra o que e obrigatorio. Os campos opcionais sao
  // perguntados pela conversa (intake/handler), que sabe quais o contador ja
  // dispensou com "pular" — aqui isso nao se sabe, e reperguntar travaria o
  // atendimento em loop.
  const faltantes = camposFaltantes(dados);
  if (!faltantes.some((f) => f.obrigatorio)) return false;

  const contexto: ContextoConversa = {
    cnpj: dados.cnpj,
    dadosParciais: dados,
    pendencias: faltantes,
    pulados: [],
    mensagemId: trabalho.mensagemId,
    chaveArquivo: trabalho.chaveArquivo,
  };

  await conversas.salvar(trabalho.escritorioId, 'confirmando_campos', contexto as Record<string, unknown>);

  const resumoLeitura =
    `Li ${dados.documentosProcessados} nota(s) de *${dados.razaoSocial ?? formatarCnpj(dados.cnpj)}* ` +
    `(${formatarCnpj(dados.cnpj)}).\n` +
    `Faturamento no periodo: R$ ${dados.faturamentoBruto.toLocaleString('pt-BR')} ` +
    `em ${dados.mesesCobertos} mes(es).\n` +
    `Composicao: ${dados.composicaoReceita.percentualB2B}% B2B / ${dados.composicaoReceita.percentualB2C}% B2C.`;

  const pergunta = faltantes[0]?.pergunta ?? '';

  await obterClienteWhatsapp().enviarTexto(
    trabalho.numeroWhatsapp,
    `${resumoLeitura}\n\nAntes de simular, preciso confirmar:\n\n${pergunta}`,
  );

  await mensagens.atualizarStatus(trabalho.mensagemId, 'processada');
  return true;
}

/** O pipeline propriamente dito, isolado para poder ser testado direto. */
export async function processarMensagem(trabalho: DadosProcessarMensagem): Promise<void> {
  const inicio = Date.now();
  await mensagens.atualizarStatus(trabalho.mensagemId, 'processando');

  try {
    // 1. Parse
    const arquivo = await obterArmazenamento().obter(trabalho.chaveArquivo);
    const extraido = await extrairDadosFiscais(arquivo, 'xml_nfe', {
      cnpjAlvo: trabalho.cnpjAlvo,
    });
    const dados = combinar(extraido, trabalho.complementos);

    // 2. Faltou algo obrigatorio? Pergunta e sai.
    if (await pedirComplementos(dados, trabalho)) return;

    // 3. Empresa
    const empresa = await empresas.garantir({
      escritorioId: trabalho.escritorioId,
      cnpj: dados.cnpj,
      razaoSocial: dados.razaoSocial ?? formatarCnpj(dados.cnpj),
      anexoSimples: dados.anexoSimples ?? null,
      uf: dados.uf ?? null,
    });

    // 4. Simulacao
    const resultado = await simular({
      cnpj: dados.cnpj,
      anexoSimples: dados.anexoSimples as string,
      faturamentoBrutoAnual: anualizarFaturamento(dados),
      composicaoReceita: dados.composicaoReceita,
      ano: new Date().getUTCFullYear(),
      folhaSalarios12m: dados.folhaSalarios12m,
      comprasComCredito: dados.comprasComCredito,
      uf: dados.uf,
    });

    // Avisos do parser viram premissas do laudo: o contador precisa ver que a
    // anualizacao foi extrapolada de 2 meses, por exemplo.
    if (dados.mesesCobertos < 12) {
      resultado.observacoes.push(
        `Faturamento anual extrapolado a partir de ${dados.mesesCobertos} mes(es) de notas.`,
      );
    }
    resultado.observacoes.push(...dados.avisos);

    // 5. Persistencia (dados cifrados — ver repositorios)
    const simulacao = await simulacoes.criar({
      empresaId: empresa.id,
      ciclo: cicloAtual(),
      dadosEntrada: { ...dados, chaveArquivo: trabalho.chaveArquivo },
      resultado,
    });

    await auditoria.registrar({
      escritorioId: trabalho.escritorioId,
      ator: trabalho.numeroWhatsapp,
      acao: 'simulacao.criada',
      entidade: 'simulacoes',
      entidadeId: simulacao.id,
      detalhe: {
        recomendacao: resultado.recomendacao,
        confianca: resultado.confianca,
        motor: resultado.versaoMotor,
      },
    });

    // 6. Laudo
    const pdf = await gerarLaudo(resultado, {
      razaoSocial: empresa.razao_social,
      cnpj: empresa.cnpj,
      anexoSimples: empresa.anexo_simples,
      uf: empresa.uf,
    });

    const chave = chaveLaudo(simulacao.id);
    await obterArmazenamento().salvar(chave, pdf, 'application/pdf');
    await simulacoes.definirLaudo(simulacao.id, chave);

    await auditoria.registrar({
      escritorioId: trabalho.escritorioId,
      ator: 'sistema',
      acao: 'laudo.gerado',
      entidade: 'simulacoes',
      entidadeId: simulacao.id,
      detalhe: { bytes: pdf.length },
    });

    // 7. Resposta com o laudo anexo
    const resumo = montarResumo(resultado, {
      razaoSocial: empresa.razao_social,
      cnpj: empresa.cnpj,
    });

    const aviso = resultado.validadoPorProfissional
      ? ''
      : '\n\n⚠️ _Simulacao provisoria: as regras de calculo ainda nao foram ' +
        'validadas por contador ou tributarista._';

    await obterClienteWhatsapp().enviarAnexo(
      trabalho.numeroWhatsapp,
      `${resumo.resumoWhatsapp}${aviso}\n\nO laudo completo esta no PDF anexo.\n\n` +
        'Quer simular outra empresa? Envie o XML ou *simular [CNPJ]*.',
      {
        nomeArquivo: `laudo-${empresa.cnpj}-${simulacao.ciclo}.pdf`,
        conteudo: pdf,
        tipoConteudo: 'application/pdf',
      },
    );

    await auditoria.registrar({
      escritorioId: trabalho.escritorioId,
      ator: 'sistema',
      acao: 'laudo.enviado',
      entidade: 'simulacoes',
      entidadeId: simulacao.id,
    });

    // 8. Fecha a conversa
    await conversas.salvar(trabalho.escritorioId, 'entregue', {
      cnpj: empresa.cnpj,
      empresaId: empresa.id,
      ultimaSimulacaoId: simulacao.id,
    });

    await mensagens.atualizarStatus(trabalho.mensagemId, 'processada');

    log.info('Simulacao concluida', {
      cnpj: empresa.cnpj,
      simulacaoId: simulacao.id,
      ms: Date.now() - inicio,
    });
  } catch (erro) {
    await tratarFalha(trabalho, erro as Error);
  }
}

/**
 * Erro de dominio (XML ilegivel, PGDAS de Fase 2) e informacao util ao
 * contador e vai para o WhatsApp com a mensagem original. Erro inesperado nao:
 * vira mensagem generica, com o detalhe ficando no banco e no log.
 */
async function tratarFalha(trabalho: DadosProcessarMensagem, erro: Error): Promise<void> {
  const ehDominio = erro instanceof ErroDominio;

  log.error('Falha no processamento da mensagem', {
    mensagemId: trabalho.mensagemId,
    dominio: ehDominio,
    erro: erro.message,
  });

  await mensagens.atualizarStatus(trabalho.mensagemId, 'erro', erro.message);

  await auditoria.registrar({
    escritorioId: trabalho.escritorioId,
    ator: 'sistema',
    acao: 'simulacao.falhou',
    entidade: 'mensagens_recebidas',
    entidadeId: trabalho.mensagemId,
    detalhe: { erro: erro.message, dominio: ehDominio },
  });

  const texto = ehDominio
    ? `Nao consegui processar: ${erro.message}`
    : 'Tive um problema inesperado ao processar esse arquivo. A equipe ja foi ' +
      'notificada. Pode tentar de novo em alguns minutos.';

  await obterClienteWhatsapp()
    .enviarTexto(trabalho.numeroWhatsapp, texto)
    .catch((e) => log.error('Falha ao avisar o contador sobre o erro', { erro: e.message }));

  await conversas
    .salvar(trabalho.escritorioId, 'ocioso', {})
    .catch(() => undefined);
}

registrarProcessador<DadosProcessarMensagem>('processar-mensagem', processarMensagem);

export { registrarProcessador };
