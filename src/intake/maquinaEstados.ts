import type { CampoFaltante, DadosFiscaisExtraidos } from '../parser/tipos';

/**
 * Fluxo guiado por estados (secao 5.3).
 *
 * A especificacao e explicita: no piloto nao vale um assistente de linguagem
 * natural completo. Uma state machine e mais previsivel, mais rapida de
 * construir e — o que mais importa aqui — mais facil de auditar quando o
 * contador reclamar que "o sistema entendeu errado".
 */

export type Estado =
  | 'ocioso'
  | 'aguardando_dados'
  | 'confirmando_campos'
  | 'processando'
  | 'entregue';

export interface ContextoConversa {
  /** CNPJ em foco na conversa. */
  cnpj?: string;
  empresaId?: string;
  /** Dados ja extraidos do XML, aguardando complemento do contador. */
  dadosParciais?: DadosFiscaisExtraidos;
  /** Perguntas ainda nao respondidas, em ordem. */
  pendencias?: CampoFaltante[];
  /** Campos que o contador dispensou com "pular" — nao perguntar de novo. */
  pulados?: string[];
  /** Id da ultima simulacao entregue. */
  ultimaSimulacaoId?: string;
  mensagemId?: string;
  chaveArquivo?: string;
}

export interface Conversa {
  estado: Estado;
  contexto: ContextoConversa;
}

export const CONVERSA_INICIAL: Conversa = { estado: 'ocioso', contexto: {} };

// --------------------------------------------------------------------------
// Interpretacao de comandos
// --------------------------------------------------------------------------

export type Comando =
  | { tipo: 'simular'; cnpj?: string }
  | { tipo: 'pendentes' }
  | { tipo: 'ajuda' }
  | { tipo: 'cancelar' }
  | { tipo: 'pular' }
  | { tipo: 'sim' }
  | { tipo: 'nao' }
  | { tipo: 'resposta'; texto: string };

const SIM = ['sim', 's', 'isso', 'ok', 'claro', 'quero', 'pode', 'positivo'];
const NAO = ['nao', 'n', 'negativo', 'agora nao', 'depois'];
const PULAR = ['pular', 'pula', 'nao sei', 'nao tenho', 'sem', 'skip'];
const CANCELAR = ['cancelar', 'cancela', 'parar', 'sair', 'reiniciar', 'recomecar'];
const PENDENTES = ['pendentes', 'pendencias', 'carteira', 'lista', 'triagem', 'quem falta'];
const AJUDA = ['ajuda', 'help', 'menu', 'comandos', 'oi', 'ola', 'bom dia', 'boa tarde', 'reforma'];

function normalizar(texto: string): string {
  return texto
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ''); // remove acentos
}

export function interpretar(textoBruto: string): Comando {
  const texto = normalizar(textoBruto);

  if (CANCELAR.includes(texto)) return { tipo: 'cancelar' };
  if (PULAR.includes(texto)) return { tipo: 'pular' };

  const simular = /^simular\b(.*)$/.exec(texto);
  if (simular) {
    const digitos = (simular[1] ?? '').replace(/\D/g, '');
    return digitos.length === 14 ? { tipo: 'simular', cnpj: digitos } : { tipo: 'simular' };
  }

  if (PENDENTES.some((p) => texto === p || texto.startsWith(p))) return { tipo: 'pendentes' };
  if (AJUDA.includes(texto)) return { tipo: 'ajuda' };
  if (SIM.includes(texto)) return { tipo: 'sim' };
  if (NAO.includes(texto)) return { tipo: 'nao' };

  return { tipo: 'resposta', texto: textoBruto.trim() };
}

// --------------------------------------------------------------------------
// Interpretacao de respostas a perguntas de complemento
// --------------------------------------------------------------------------

/** Aceita "III", "anexo 3", "3" — o contador escreve de todo jeito. */
export function interpretarAnexo(texto: string): string | null {
  const limpo = normalizar(texto).replace(/anexo\s*/i, '').trim().toUpperCase();

  const romanos = ['I', 'II', 'III', 'IV', 'V'];
  if (romanos.includes(limpo)) return limpo;

  const arabe = Number(limpo);
  if (Number.isInteger(arabe) && arabe >= 1 && arabe <= 5) {
    return romanos[arabe - 1] as string;
  }

  return null;
}

/**
 * Aceita "120.000,00", "120000", "R$ 120 mil", "1.2 milhao".
 * Retorna null quando nao consegue ler com seguranca — melhor perguntar de
 * novo do que simular com um numero inventado.
 */
export function interpretarValor(texto: string): number | null {
  const limpo = normalizar(texto).replace(/r\$\s*/g, '').trim();

  const multiplicador = /\bmilh(ao|oes)\b/.test(limpo)
    ? 1_000_000
    : /\bmil\b/.test(limpo)
      ? 1_000
      : 1;

  const numerico = limpo.replace(/\b(mil|milhao|milhoes)\b/g, '').trim();
  if (numerico === '') return null;

  // Formato brasileiro: ponto e milhar, virgula e decimal.
  const normalizado = numerico.includes(',')
    ? numerico.replace(/\./g, '').replace(',', '.')
    : numerico.replace(/\.(?=\d{3}\b)/g, '');

  const somenteNumero = normalizado.replace(/[^\d.]/g, '');
  // Sem nenhum digito nao ha valor nenhum: "nao sei direito" nao pode virar 0,
  // ou a simulacao rodaria com folha/compras zeradas sem ninguem perceber.
  if (!/\d/.test(somenteNumero)) return null;

  const valor = Number(somenteNumero);
  if (!Number.isFinite(valor) || valor < 0) return null;

  return valor * multiplicador;
}

// --------------------------------------------------------------------------
// Transicoes
// --------------------------------------------------------------------------

const TRANSICOES: Record<Estado, Estado[]> = {
  ocioso: ['aguardando_dados', 'confirmando_campos', 'processando'],
  aguardando_dados: ['confirmando_campos', 'processando', 'ocioso'],
  confirmando_campos: ['confirmando_campos', 'processando', 'ocioso'],
  processando: ['entregue', 'ocioso'],
  entregue: ['ocioso', 'aguardando_dados', 'confirmando_campos', 'processando'],
};

export function podeTransitar(de: Estado, para: Estado): boolean {
  return de === para || (TRANSICOES[de]?.includes(para) ?? false);
}

export function proximaPendencia(contexto: ContextoConversa): CampoFaltante | null {
  return contexto.pendencias?.[0] ?? null;
}

/** Remove a pendencia respondida e devolve o contexto atualizado. */
export function resolverPendencia(
  contexto: ContextoConversa,
  campo: string,
): ContextoConversa {
  return {
    ...contexto,
    pendencias: (contexto.pendencias ?? []).filter((p) => p.campo !== campo),
  };
}

export const TEXTO_AJUDA =
  'Sou o *Copiloto da Reforma*. Posso simular se vale a pena cada cliente seu ' +
  'continuar recolhendo dentro do DAS ou passar a recolher IBS/CBS por fora.\n\n' +
  'O que voce pode fazer:\n\n' +
  '📎 *Enviar o XML* das notas fiscais de um cliente — eu leio e simulo.\n' +
  '🔎 *simular [CNPJ]* — simula uma empresa ja cadastrada.\n' +
  '📋 *pendentes* — mostra quais CNPJs da sua carteira ainda nao tem decisao.\n' +
  '❌ *cancelar* — abandona o atendimento atual.\n\n' +
  'Toda simulacao vem com um laudo em PDF para voce conferir e anexar ao processo.';
