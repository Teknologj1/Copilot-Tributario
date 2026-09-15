import { registrarProcessador } from './fila';
import { config } from '../config';
import { obterArmazenamento } from '../armazenamento';
import { mensagens, simulacoes } from '../db/repositorios';
import * as auditoria from '../db/auditoria';
import { log } from '../comum/log';

/**
 * Politica de retencao — secao 8.
 *
 * "Por quanto tempo os XMLs e PGDAS ficam armazenados apos o processamento?
 * Defina isso antes de comecar a receber dados reais, nao depois."
 *
 * Duas janelas, porque os dois artefatos tem valor diferente:
 *  - arquivo bruto (XML): RETENCAO_ARQUIVOS_DIAS, padrao 90 dias. E o dado
 *    mais sensivel e o de menor valor depois de processado.
 *  - dados de entrada da simulacao: RETENCAO_DADOS_ENTRADA_DIAS, padrao 365.
 *    Guardados cifrados; sao o que permite reconstituir um laudo antigo.
 *
 * O laudo em si e o registro da auditoria nao sao apagados: sao a prova do
 * que foi entregue ao contador.
 */

export interface ResultadoExpurgo {
  arquivosRemovidos: number;
  dadosEntradaExpurgados: number;
}

export async function executarRetencao(): Promise<ResultadoExpurgo> {
  const agora = Date.now();
  const umDia = 86_400_000;

  // --- 1. Arquivos brutos ja processados ---
  const limiteArquivos = new Date(agora - config.seguranca.retencaoArquivosDias * umDia);
  const antigas = await mensagens.anterioresA(limiteArquivos);

  let arquivosRemovidos = 0;
  const armazenamento = obterArmazenamento();

  for (const mensagem of antigas) {
    const chave = mensagem.conteudo_bruto;
    if (!chave) continue;

    try {
      await armazenamento.remover(chave);
      await mensagens.limparConteudoBruto(mensagem.id);
      arquivosRemovidos += 1;
    } catch (erro) {
      log.error('Falha ao expurgar arquivo', {
        mensagemId: mensagem.id,
        erro: (erro as Error).message,
      });
    }
  }

  // --- 2. Dados de entrada das simulacoes ---
  const limiteDados = new Date(agora - config.seguranca.retencaoDadosEntradaDias * umDia);
  const dadosEntradaExpurgados = await simulacoes.expurgarDadosEntradaAnterioresA(limiteDados);

  await auditoria.registrar({
    escritorioId: null,
    ator: 'sistema',
    acao: 'retencao.expurgo',
    detalhe: {
      arquivosRemovidos,
      dadosEntradaExpurgados,
      retencaoArquivosDias: config.seguranca.retencaoArquivosDias,
      retencaoDadosEntradaDias: config.seguranca.retencaoDadosEntradaDias,
    },
  });

  log.info('Retencao executada', { arquivosRemovidos, dadosEntradaExpurgados });

  return { arquivosRemovidos, dadosEntradaExpurgados };
}

registrarProcessador('retencao', async () => {
  await executarRetencao();
});
