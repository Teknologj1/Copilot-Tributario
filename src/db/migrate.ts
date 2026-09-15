import fs from 'node:fs';
import path from 'node:path';
import { query, fecharPool, transacao } from './index';
import { log } from '../comum/log';

/**
 * Runner de migrations. Aplica em ordem alfabetica os .sql de db/migrations
 * que ainda nao foram aplicados, cada um dentro de sua propria transacao.
 *
 *   npm run migrate
 */

const DIR_MIGRATIONS = path.join(__dirname, 'migrations');

async function garantirTabelaControle(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      nome        TEXT PRIMARY KEY,
      aplicada_em TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function migrar(): Promise<string[]> {
  await garantirTabelaControle();

  const aplicadas = new Set(
    (await query<{ nome: string }>('SELECT nome FROM schema_migrations')).map(
      (l) => l.nome,
    ),
  );

  const arquivos = fs
    .readdirSync(DIR_MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const novas: string[] = [];

  for (const arquivo of arquivos) {
    if (aplicadas.has(arquivo)) continue;

    const sql = fs.readFileSync(path.join(DIR_MIGRATIONS, arquivo), 'utf8');
    log.info('Aplicando migration', { arquivo });

    await transacao(async (cliente) => {
      await cliente.query(sql);
      await cliente.query('INSERT INTO schema_migrations (nome) VALUES ($1)', [
        arquivo,
      ]);
    });

    novas.push(arquivo);
  }

  return novas;
}

if (require.main === module) {
  migrar()
    .then(async (novas) => {
      if (novas.length === 0) log.info('Banco ja esta atualizado');
      else log.info('Migrations aplicadas', { total: novas.length, novas });
      await fecharPool();
    })
    .catch(async (erro) => {
      log.error('Falha ao migrar', { erro: erro.message });
      await fecharPool();
      process.exit(1);
    });
}
