import { config } from '../config';
import { log } from '../comum/log';

/**
 * Fila de processamento (secao 3): o parsing e a simulacao nao podem travar o
 * webhook do WhatsApp.
 *
 * Dois drivers:
 *  - BullMQ/Redis quando REDIS_URL existe — o modo de producao;
 *  - inline quando nao existe — executa no mesmo tick, com o pipeline
 *    identico. E o que permite rodar o piloto e a suite de testes ponta a
 *    ponta sem subir Redis.
 */

export type NomeFila = 'processar-mensagem' | 'retencao';

export interface Trabalho<T = unknown> {
  nome: NomeFila;
  dados: T;
}

export type Processador<T = any> = (dados: T) => Promise<void>;

const processadores = new Map<NomeFila, Processador>();

export function registrarProcessador<T>(nome: NomeFila, processador: Processador<T>): void {
  processadores.set(nome, processador as Processador);
}

export function usandoRedis(): boolean {
  return Boolean(config.redis.url);
}

// --------------------------------------------------------------------------
// Driver BullMQ
// --------------------------------------------------------------------------

type QualquerFila = { add: (nome: string, dados: unknown, opcoes?: unknown) => Promise<unknown>; close: () => Promise<void> };

const filasBull = new Map<NomeFila, QualquerFila>();
const workersBull: { close: () => Promise<void> }[] = [];

function opcoesConexao(): { connection: { url: string } } {
  return { connection: { url: config.redis.url } };
}

function obterFilaBull(nome: NomeFila): QualquerFila {
  const existente = filasBull.get(nome);
  if (existente) return existente;

  // require tardio: sem Redis configurado, BullMQ nem e carregado.
  const { Queue } = require('bullmq');
  const fila = new Queue(nome, {
    ...opcoesConexao(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 86_400, count: 1_000 },
      removeOnFail: { age: 604_800 },
    },
  }) as QualquerFila;

  filasBull.set(nome, fila);
  return fila;
}

// --------------------------------------------------------------------------
// API publica
// --------------------------------------------------------------------------

/**
 * Enfileira um trabalho. No modo inline o erro do processador e capturado e
 * logado — igual ao que a fila real faz — para que o webhook nao devolva 500
 * por causa de uma falha de processamento assincrono.
 */
export async function enfileirar<T>(nome: NomeFila, dados: T): Promise<void> {
  if (usandoRedis()) {
    await obterFilaBull(nome).add(nome, dados);
    return;
  }

  const processador = processadores.get(nome);
  if (!processador) {
    throw new Error(
      `Nenhum processador registrado para "${nome}". ` +
        'No modo inline, importe src/fila/processadores antes de enfileirar.',
    );
  }

  try {
    await processador(dados);
  } catch (erro) {
    log.error('Falha ao processar trabalho no modo inline', {
      fila: nome,
      erro: (erro as Error).message,
    });
  }
}

/** Sobe os workers BullMQ. No modo inline nao ha o que subir. */
export function iniciarWorkers(): void {
  if (!usandoRedis()) {
    log.warn(
      'REDIS_URL ausente: fila em modo inline. Adequado para desenvolvimento e ' +
        'testes; em producao configure Redis e rode o worker separado.',
    );
    return;
  }

  const { Worker } = require('bullmq');

  for (const [nome, processador] of processadores) {
    const worker = new Worker(
      nome,
      async (job: { data: unknown }) => processador(job.data),
      { ...opcoesConexao(), concurrency: Number(process.env.FILA_CONCORRENCIA ?? 5) },
    );

    worker.on('failed', (job: { id?: string } | undefined, erro: Error) => {
      log.error('Trabalho falhou', { fila: nome, job: job?.id, erro: erro.message });
    });

    workersBull.push(worker);
    log.info('Worker iniciado', { fila: nome });
  }
}

export async function fecharFilas(): Promise<void> {
  await Promise.all(workersBull.map((w) => w.close()));
  workersBull.length = 0;
  await Promise.all([...filasBull.values()].map((f) => f.close()));
  filasBull.clear();
}
