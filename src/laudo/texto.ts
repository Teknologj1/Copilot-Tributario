import { formatarCnpj } from '../comum/cnpj';
import type { ResultadoSimulacao, ResultadoSimulacaoAno } from '../simulacao/interface';

/**
 * Explicacao em linguagem simples (5.4) — deterministica, sem LLM no caminho
 * critico do piloto. Um laudo assinado por contador nao pode variar de texto a
 * cada geracao, e uma chamada de modelo no meio do pipeline e mais uma coisa
 * para cair em producao.
 */

export function moeda(valor: number): string {
  return valor.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  });
}

export function percentual(valor: number): string {
  return `${valor.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}

export const AVISO_RESPONSABILIDADE =
  'Este documento e material de apoio a decisao. A responsabilidade tecnica pela ' +
  'analise e pela decisao de enquadramento permanece integralmente com o contador ' +
  'responsavel pela empresa, a quem cabe validar as premissas aqui utilizadas.';

export const TARJA_PROVISORIA =
  'SIMULACAO PROVISORIA — as regras de calculo ainda nao foram revisadas por ' +
  'contador ou tributarista. Nao utilize como base de decisao final.';

function totalPeriodo(projecao: ResultadoSimulacaoAno[], campo: 'cargaTributariaDentroDAS' | 'cargaTributariaForaDAS'): number {
  return projecao.reduce((soma, ano) => soma + ano[campo], 0);
}

/** Primeiro ano em que o cenario recomendado deixa de ser o melhor, se houver. */
function anoDeVirada(projecao: ResultadoSimulacaoAno[]): ResultadoSimulacaoAno | null {
  if (projecao.length < 2) return null;
  const primeiro = projecao[0] as ResultadoSimulacaoAno;
  const sinalInicial = Math.sign(primeiro.diferenca);
  if (sinalInicial === 0) return null;
  return projecao.find((a) => Math.sign(a.diferenca) !== sinalInicial && a.diferenca !== 0) ?? null;
}

export interface ResumoLaudo {
  titulo: string;
  paragrafos: string[];
  /** Versao curta para a mensagem de WhatsApp. */
  resumoWhatsapp: string;
}

export function montarResumo(
  resultado: ResultadoSimulacao,
  empresa: { razaoSocial: string; cnpj: string },
): ResumoLaudo {
  const { projecaoPorAno, recomendacao } = resultado;
  const ficaDentro = recomendacao === 'dentro_das';

  const totalDentro = totalPeriodo(projecaoPorAno, 'cargaTributariaDentroDAS');
  const totalFora = totalPeriodo(projecaoPorAno, 'cargaTributariaForaDAS');
  const economia = Math.abs(totalFora - totalDentro);

  const anos = projecaoPorAno.map((a) => a.ano);
  const janela =
    anos.length > 1 ? `${anos[0]} a ${anos[anos.length - 1]}` : String(anos[0] ?? '');

  const titulo = ficaDentro
    ? 'Recomendacao: PERMANECER dentro do DAS'
    : 'Recomendacao: RECOLHER FORA do DAS (IBS/CBS por fora)';

  const paragrafos: string[] = [];

  // 1. O que foi comparado e qual o veredito.
  paragrafos.push(
    `Comparamos, para a ${empresa.razaoSocial} (CNPJ ${formatarCnpj(empresa.cnpj)}), dois caminhos ` +
      `possiveis durante a transicao da reforma tributaria: continuar recolhendo tudo dentro do ` +
      `DAS do Simples Nacional, ou passar a recolher o IBS e a CBS por fora do DAS. ` +
      `Somando os anos simulados (${janela}), o caminho ${ficaDentro ? 'de permanecer dentro do DAS' : 'de recolher por fora do DAS'} ` +
      `sai aproximadamente ${moeda(economia)} mais barato no total do periodo.`,
  );

  // 2. Por que — o mecanismo, nao so o numero.
  const b2b = resultado.memoriaCalculo.find((l) =>
    l.rubrica.startsWith('Custo comercial'),
  );
  if (b2b && b2b.valor > 0) {
    paragrafos.push(
      ficaDentro
        ? `A conta considera que, dentro do DAS, parte dos clientes pessoa juridica nao consegue ` +
            `aproveitar todo o credito de IBS/CBS da compra, o que tende a virar pressao por desconto. ` +
            `Mesmo com esse custo comercial embutido, o valor recolhido no Simples continua compensando ` +
            `para o perfil de faturamento e de clientela desta empresa.`
        : `O ponto que inverte a conta e o credito: com uma parcela relevante do faturamento vindo de ` +
            `clientes pessoa juridica, ficar dentro do DAS faz esses clientes perderem credito de ` +
            `IBS/CBS, e essa perda tende a voltar como pressao de preco. Recolhendo por fora, o credito ` +
            `e transferido integralmente e a empresa deixa de absorver esse custo.`,
    );
  } else {
    paragrafos.push(
      ficaDentro
        ? `Com a clientela predominantemente de consumidor final, a questao do credito de IBS/CBS pesa ` +
            `pouco nesta empresa: quem compra nao aproveita credito de qualquer forma. Nesse cenario, a ` +
            `simplicidade e a carga do Simples tendem a ser vantajosas.`
        : `Mesmo com pouca clientela pessoa juridica, a carga projetada fora do DAS ficou menor para ` +
            `este perfil de faturamento ao longo da transicao.`,
    );
  }

  // 3. O que muda ao longo da transicao — o ponto que a decisao de hoje costuma ignorar.
  const virada = anoDeVirada(projecaoPorAno);
  if (virada) {
    paragrafos.push(
      `Atencao ao efeito do tempo: a vantagem nao e a mesma em todos os anos. A partir de ${virada.ano}, ` +
        `a relacao entre os dois cenarios se inverte, conforme o IBS e a CBS substituem os tributos atuais. ` +
        `A recomendacao acima considera o periodo inteiro, e nao apenas o primeiro ano — decidir olhando ` +
        `so para ${anos[0]} levaria a uma conclusao diferente e provavelmente errada para o fim da transicao.`,
    );
  } else {
    paragrafos.push(
      `A vantagem se mantem na mesma direcao em todos os anos simulados, o que torna a recomendacao ` +
        `mais estavel: a conclusao nao depende de onde exatamente a empresa esta na linha do tempo da transicao.`,
    );
  }

  const resumoWhatsapp =
    `*${titulo}*\n\n` +
    `${empresa.razaoSocial} — ${formatarCnpj(empresa.cnpj)}\n` +
    `Diferenca estimada no periodo ${janela}: *${moeda(economia)}*\n` +
    `Confianca da simulacao: *${resultado.confianca}*`;

  return { titulo, paragrafos, resumoWhatsapp };
}
