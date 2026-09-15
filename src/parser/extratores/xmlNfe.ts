import { XMLParser } from 'fast-xml-parser';
import { ErroParser } from '../../comum/erros';
import { cnpjValido, normalizarCnpj } from '../../comum/cnpj';
import type { DadosFiscaisExtraidos } from '../tipos';

/**
 * Extrator de XML de NF-e (modelos 55 e 65).
 *
 * Aceita um arquivo com uma nota, um nfeProc, ou um lote (enviNFe / varias
 * NFe no mesmo documento) — o contador costuma mandar o mes inteiro de uma vez.
 *
 * O campo que mais importa e o mais dificil: a composicao B2B x B2C. Ela e
 * derivada do destinatario de cada nota — dest com CNPJ e venda para empresa
 * (cliente que toma credito), dest com CPF e consumidor final — ponderada pelo
 * valor, nao pela contagem de notas. Uma venda de R$ 50 mil para industria e
 * cem vendas de R$ 50 no balcao nao pesam igual na decisao.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false, // valores ficam string: preserva "0001" e evita float capenga
  trimValues: true,
});

interface NotaNormalizada {
  emitenteCnpj: string;
  emitenteNome?: string;
  emitenteUf?: string;
  crt?: number;
  /** 0 = entrada, 1 = saida */
  tipo: number;
  valor: number;
  competencia: string;
  destinatarioEhEmpresa: boolean;
}

function comoArray(valor: unknown): unknown[] {
  if (valor === undefined || valor === null) return [];
  return Array.isArray(valor) ? valor : [valor];
}

/** Busca recursiva por todos os nos infNFe, seja qual for o envelope. */
function coletarInfNFe(no: unknown, encontrados: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (typeof no !== 'object' || no === null) return encontrados;

  for (const [chave, valor] of Object.entries(no as Record<string, unknown>)) {
    if (chave === 'infNFe') {
      for (const item of comoArray(valor)) {
        if (typeof item === 'object' && item !== null) {
          encontrados.push(item as Record<string, unknown>);
        }
      }
      continue;
    }
    for (const filho of comoArray(valor)) {
      coletarInfNFe(filho, encontrados);
    }
  }

  return encontrados;
}

function texto(valor: unknown): string | undefined {
  if (valor === undefined || valor === null) return undefined;
  if (typeof valor === 'object') {
    // fast-xml-parser devolve objeto quando a tag tem atributo; o texto fica em '#text'.
    const t = (valor as Record<string, unknown>)['#text'];
    return t === undefined ? undefined : String(t);
  }
  return String(valor);
}

function numero(valor: unknown): number {
  const t = texto(valor);
  if (t === undefined) return 0;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function competenciaDe(dhEmi: string | undefined, dEmi: string | undefined): string | undefined {
  const bruto = dhEmi ?? dEmi;
  if (!bruto) return undefined;
  // dhEmi vem como 2026-01-15T10:00:00-03:00; dEmi (leiautes antigos) como 2026-01-15.
  const m = /^(\d{4})-(\d{2})/.exec(bruto);
  return m ? `${m[1]}-${m[2]}` : undefined;
}

function normalizarNota(infNFe: Record<string, unknown>): NotaNormalizada | null {
  const ide = infNFe.ide as Record<string, unknown> | undefined;
  const emit = infNFe.emit as Record<string, unknown> | undefined;
  const dest = infNFe.dest as Record<string, unknown> | undefined;
  const total = infNFe.total as Record<string, unknown> | undefined;

  if (!emit) return null;

  const emitenteCnpj = normalizarCnpj(texto(emit.CNPJ) ?? '');
  if (!emitenteCnpj) return null;

  const competencia = competenciaDe(texto(ide?.dhEmi), texto(ide?.dEmi));
  if (!competencia) return null;

  // Valor da nota: prefere vNF do total; cai para a soma dos itens se ausente.
  const icmsTot = total?.ICMSTot as Record<string, unknown> | undefined;
  let valor = numero(icmsTot?.vNF);
  if (valor === 0) {
    for (const det of comoArray(infNFe.det)) {
      const prod = (det as Record<string, unknown>)?.prod as Record<string, unknown> | undefined;
      valor += numero(prod?.vProd);
    }
  }

  const enderEmit = emit.enderEmit as Record<string, unknown> | undefined;

  return {
    emitenteCnpj,
    emitenteNome: texto(emit.xNome),
    emitenteUf: texto(enderEmit?.UF),
    crt: texto(emit.CRT) ? Number(texto(emit.CRT)) : undefined,
    // Sem tpNF assume saida: NF-e de entrada e minoria e o contador manda
    // justamente as notas de faturamento.
    tipo: texto(ide?.tpNF) !== undefined ? Number(texto(ide?.tpNF)) : 1,
    valor,
    competencia,
    destinatarioEhEmpresa: Boolean(dest && texto(dest.CNPJ)),
  };
}

export interface OpcoesExtracaoXml {
  /**
   * Quando o lote tem notas de varios emitentes, restringe a este CNPJ.
   * Sem ele, vence o emitente com maior faturamento no lote.
   */
  cnpjAlvo?: string;
}

export async function extrairDeXmlNfe(
  arquivo: Buffer,
  opcoes: OpcoesExtracaoXml = {},
): Promise<DadosFiscaisExtraidos> {
  const conteudo = arquivo.toString('utf8').replace(/^﻿/, '');

  if (conteudo.trim() === '') {
    throw new ErroParser('Arquivo XML vazio.');
  }

  let arvore: unknown;
  try {
    arvore = parser.parse(conteudo);
  } catch (erro) {
    throw new ErroParser(`XML malformado: ${(erro as Error).message}`);
  }

  const infNFes = coletarInfNFe(arvore);
  if (infNFes.length === 0) {
    throw new ErroParser(
      'Nenhuma NF-e encontrada no arquivo. Confira se o XML e mesmo de nota fiscal ' +
        '(o arquivo de um DANFE em PDF, por exemplo, nao serve).',
    );
  }

  const notas = infNFes
    .map(normalizarNota)
    .filter((n): n is NotaNormalizada => n !== null);

  if (notas.length === 0) {
    throw new ErroParser(
      'As notas encontradas nao tem emitente ou data de emissao legiveis.',
    );
  }

  // --- Escolhe o emitente a simular ---
  const porEmitente = new Map<string, NotaNormalizada[]>();
  for (const nota of notas) {
    const lista = porEmitente.get(nota.emitenteCnpj) ?? [];
    lista.push(nota);
    porEmitente.set(nota.emitenteCnpj, lista);
  }

  const avisos: string[] = [];
  let cnpjEscolhido: string;

  if (opcoes.cnpjAlvo) {
    cnpjEscolhido = normalizarCnpj(opcoes.cnpjAlvo);
    if (!porEmitente.has(cnpjEscolhido)) {
      throw new ErroParser(
        `O arquivo nao contem notas emitidas pelo CNPJ informado.`,
        { emitentesEncontrados: porEmitente.size },
      );
    }
  } else {
    const ranking = [...porEmitente.entries()].sort(
      (a, b) =>
        b[1].reduce((s, n) => s + n.valor, 0) - a[1].reduce((s, n) => s + n.valor, 0),
    );
    cnpjEscolhido = ranking[0]?.[0] as string;
    if (porEmitente.size > 1) {
      avisos.push(
        `O arquivo tem notas de ${porEmitente.size} emitentes diferentes. Foi considerado ` +
          'o de maior faturamento; se nao for a empresa certa, informe o CNPJ na mensagem.',
      );
    }
  }

  const doEmitente = porEmitente.get(cnpjEscolhido) as NotaNormalizada[];
  const saidas = doEmitente.filter((n) => n.tipo === 1);

  if (saidas.length === 0) {
    throw new ErroParser(
      'Foram encontradas apenas notas de entrada. Para simular o regime e preciso ' +
        'o faturamento (notas de saida).',
    );
  }

  const descartadas = doEmitente.length - saidas.length;
  if (descartadas > 0) {
    avisos.push(`${descartadas} nota(s) de entrada foram ignoradas no calculo do faturamento.`);
  }

  // --- Faturamento e composicao da receita ---
  const faturamentoBruto = saidas.reduce((s, n) => s + n.valor, 0);
  const receitaB2B = saidas.filter((n) => n.destinatarioEhEmpresa).reduce((s, n) => s + n.valor, 0);

  let percentualB2B = 0;
  if (faturamentoBruto > 0) {
    percentualB2B = Math.round((receitaB2B / faturamentoBruto) * 1000) / 10;
  } else {
    avisos.push('As notas de saida somam zero — confira se o arquivo esta completo.');
  }
  const percentualB2C = Math.round((100 - percentualB2B) * 10) / 10;

  const periodos = [...new Set(saidas.map((n) => n.competencia))].sort();
  const ultimo = periodos[periodos.length - 1] as string;

  if (periodos.length === 1) {
    avisos.push(
      'Os dados cobrem um unico mes. A projecao anual sera feita por extrapolacao, ' +
        'o que ignora sazonalidade.',
    );
  }

  const referencia = saidas[0] as NotaNormalizada;
  if (referencia.crt === 3) {
    avisos.push(
      'O CRT das notas indica Regime Normal, nao Simples Nacional. Confirme o ' +
        'enquadramento antes de considerar a simulacao.',
    );
  }

  if (!cnpjValido(cnpjEscolhido)) {
    avisos.push('O CNPJ do emitente nao passou na validacao de digitos verificadores.');
  }

  return {
    cnpj: cnpjEscolhido,
    periodo: ultimo,
    faturamentoBruto: Math.round(faturamentoBruto * 100) / 100,
    composicaoReceita: { percentualB2B, percentualB2C },
    razaoSocial: referencia.emitenteNome,
    uf: referencia.emitenteUf,
    mesesCobertos: periodos.length,
    periodos,
    documentosProcessados: saidas.length,
    regimeTributarioDeclarado: referencia.crt,
    origem: 'xml_nfe',
    avisos,
  };
}
