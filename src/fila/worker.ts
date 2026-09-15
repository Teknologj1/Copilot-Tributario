import { iniciarWorkers, fecharFilas } from './fila';
import { fecharPool } from '../db';
import { log } from '../comum/log';

// Importar registra os processadores nas filas.
import './processadores';
import './retencao';

/**
 * Processo worker separado (npm run worker). Em producao roda ao lado da API;
 * em desenvolvimento, sem Redis, nao e necessario — a fila roda inline.
 */

iniciarWorkers();
log.info('Worker do Copiloto da Reforma iniciado');

async function encerrar(sinal: string): Promise<void> {
  log.info('Encerrando worker', { sinal });
  await fecharFilas();
  await fecharPool().catch(() => undefined);
  process.exit(0);
}

process.on('SIGTERM', () => void encerrar('SIGTERM'));
process.on('SIGINT', () => void encerrar('SIGINT'));
