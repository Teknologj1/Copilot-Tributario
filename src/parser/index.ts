import { ErroParser } from '../comum/erros';
import { extrairDeXmlNfe, type OpcoesExtracaoXml } from './extratores/xmlNfe';
import { extrairDePgdas } from './extratores/pgdas';
import { extrairDeSped } from './extratores/sped';
import type { CampoFaltante, DadosFiscaisExtraidos, TipoArquivoFiscal } from './tipos';

export type { DadosFiscaisExtraidos, CampoFaltante, TipoArquivoFiscal };
export { extrairDeXmlNfe };

/**
 * Assinatura da secao 5.1:
 *   extrairDadosFiscais(arquivo, tipo): Promise<DadosFiscaisExtraidos>
 */
export async function extrairDadosFiscais(
  arquivo: Buffer,
  tipo: TipoArquivoFiscal,
  opcoes: OpcoesExtracaoXml = {},
): Promise<DadosFiscaisExtraidos> {
  switch (tipo) {
    case 'xml_nfe':
      return extrairDeXmlNfe(arquivo, opcoes);
    case 'pgdas':
      return extrairDePgdas(arquivo);
    case 'sped':
      return extrairDeSped(arquivo);
    default:
      throw new ErroParser(`Tipo de arquivo fiscal desconhecido: ${String(tipo)}`);
  }
}

/**
 * Anualiza o faturamento a partir do periodo coberto pelos documentos.
 *
 * O motor raciocina em receita bruta de 12 meses (RBT12) — e a base das
 * tabelas do Simples. O XML traz o que traz: as vezes um mes, as vezes o ano.
 * A extrapolacao e explicita e fica registrada nos avisos, em vez de acontecer
 * escondida dentro do calculo.
 */
export function anualizarFaturamento(dados: DadosFiscaisExtraidos): number {
  const meses = Math.max(1, dados.mesesCobertos);
  if (meses >= 12) return dados.faturamentoBruto;
  return Math.round((dados.faturamentoBruto / meses) * 12 * 100) / 100;
}

/**
 * Diz o que ainda falta para simular com confianca.
 *
 * A secao 5.1 e explicita: nao vale travar o piloto tentando extrair 100%
 * automaticamente — o contador confirma o que faltar. Esta funcao e o que a
 * camada conversacional usa para montar as perguntas.
 */
export function camposFaltantes(dados: DadosFiscaisExtraidos): CampoFaltante[] {
  const faltantes: CampoFaltante[] = [];

  if (!dados.anexoSimples) {
    faltantes.push({
      campo: 'anexoSimples',
      pergunta:
        'Qual o Anexo do Simples Nacional desta empresa? Responda com o numero: I, II, III, IV ou V.',
      obrigatorio: true,
    });
  }

  // Folha so importa onde o Fator R decide o anexo (III <-> V). Perguntar a
  // folha de um comercio do Anexo I e ruido que atrasa o atendimento.
  const fatorRSeAplica = dados.anexoSimples === 'III' || dados.anexoSimples === 'V';

  if (fatorRSeAplica && dados.folhaSalarios12m === undefined) {
    faltantes.push({
      campo: 'folhaSalarios12m',
      pergunta:
        'Qual a folha de salarios dos ultimos 12 meses (com encargos)? Ela define o Fator R e ' +
        'muda bastante o resultado para prestadores de servico. Se nao tiver o numero, responda "pular".',
      obrigatorio: false,
    });
  }

  if (dados.comprasComCredito === undefined) {
    faltantes.push({
      campo: 'comprasComCredito',
      pergunta:
        'Qual o valor anual de compras e insumos que gerariam credito de IBS/CBS? ' +
        'Sem esse dado o cenario "fora do DAS" fica subestimado. Responda "pular" se preferir.',
      obrigatorio: false,
    });
  }

  return faltantes;
}
