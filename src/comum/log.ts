import { mascararCnpj } from '../seguranca/cripto';

/**
 * Log estruturado minimo. Nao existe transporte externo no piloto — stdout, e
 * o ambiente coleta. A regra que importa: dado fiscal de terceiro nao vai
 * para log. Use `cnpj:` no contexto e ele sai mascarado.
 */

type Nivel = 'debug' | 'info' | 'warn' | 'error';

const CAMPOS_PROIBIDOS = new Set([
  'dados_entrada',
  'dadosEntrada',
  'resultado',
  'conteudoBruto',
  'xml',
  'apiKey',
  'chave',
  'token',
]);

function higienizar(ctx: Record<string, unknown>): Record<string, unknown> {
  const saida: Record<string, unknown> = {};
  for (const [chave, valor] of Object.entries(ctx)) {
    if (CAMPOS_PROIBIDOS.has(chave)) {
      saida[chave] = '[omitido]';
    } else if (chave === 'cnpj' && typeof valor === 'string') {
      saida[chave] = mascararCnpj(valor);
    } else {
      saida[chave] = valor;
    }
  }
  return saida;
}

function emitir(nivel: Nivel, mensagem: string, ctx: Record<string, unknown> = {}): void {
  const linha = JSON.stringify({
    nivel,
    mensagem,
    ...higienizar(ctx),
    ts: new Date().toISOString(),
  });
  if (nivel === 'error') console.error(linha);
  else if (nivel === 'warn') console.warn(linha);
  else console.log(linha);
}

export const log = {
  debug: (m: string, c?: Record<string, unknown>) => emitir('debug', m, c),
  info: (m: string, c?: Record<string, unknown>) => emitir('info', m, c),
  warn: (m: string, c?: Record<string, unknown>) => emitir('warn', m, c),
  error: (m: string, c?: Record<string, unknown>) => emitir('error', m, c),
};
