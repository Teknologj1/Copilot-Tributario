import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { config } from '../config';
import { log } from '../comum/log';

/**
 * Pool de conexoes. Criado sob demanda para que modulos que nao tocam o banco
 * (parser, motor, laudo) possam ser importados e testados sem Postgres no ar.
 */

let pool: Pool | null = null;

export function obterPool(): Pool {
  if (pool) return pool;

  if (!config.banco.url) {
    throw new Error(
      'DATABASE_URL nao configurada. Ver .env.example para o formato esperado.',
    );
  }

  pool = new Pool({
    connectionString: config.banco.url,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on('error', (erro) => {
    log.error('Erro em conexao ociosa do pool', { erro: erro.message });
  });

  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  valores: unknown[] = [],
): Promise<T[]> {
  const resultado = await obterPool().query<T>(sql, valores);
  return resultado.rows;
}

export async function queryUm<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  valores: unknown[] = [],
): Promise<T | null> {
  const linhas = await query<T>(sql, valores);
  return linhas[0] ?? null;
}

/**
 * Executa em transacao, com rollback automatico em caso de erro. O pipeline
 * grava simulacao + atualiza empresa + registra auditoria de uma vez; ou tudo
 * acontece, ou nada acontece.
 */
export async function transacao<T>(
  fn: (cliente: PoolClient) => Promise<T>,
): Promise<T> {
  const cliente = await obterPool().connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await fn(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (erro) {
    await cliente.query('ROLLBACK').catch(() => undefined);
    throw erro;
  } finally {
    cliente.release();
  }
}

export async function fecharPool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}

export type { PoolClient };
