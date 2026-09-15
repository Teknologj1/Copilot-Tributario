import Fastify, { type FastifyInstance } from 'fastify';
import { config, ehProducao } from './config';
import { registrarRotas, tratadorDeErros } from './api/routes';
import { iniciarWorkers, fecharFilas, usandoRedis } from './fila/fila';
import { fecharPool } from './db';
import { log } from './comum/log';

// Importar registra os processadores — necessario inclusive no modo inline.
import './fila/processadores';
import './fila/retencao';

/**
 * Servidor HTTP do piloto. Monolito bem dividido em modulos, como decidido na
 * secao 2 — nao ha microservico aqui.
 */

export async function construirApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // log proprio, que higieniza dado fiscal (comum/log.ts)
    bodyLimit: 25 * 1024 * 1024, // XML de um mes inteiro de notas cabe folgado
    trustProxy: true,
  });

  // Guarda o corpo bruto: a assinatura HMAC do webhook e calculada sobre os
  // bytes originais, nao sobre o JSON reserializado.
  app.addHook('onRequest', async (req) => {
    (req as { rawBody?: Buffer }).rawBody = undefined;
  });

  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, corpo, feito) => {
      (req as { rawBody?: Buffer }).rawBody = corpo as Buffer;
      try {
        feito(null, (corpo as Buffer).length === 0 ? {} : JSON.parse((corpo as Buffer).toString('utf8')));
      } catch (erro) {
        feito(erro as Error, undefined);
      }
    },
  );

  app.setErrorHandler(tratadorDeErros);
  await registrarRotas(app);

  return app;
}

/**
 * Checagens de producao. A secao 8 e explicita sobre nao colocar o piloto no ar
 * sem as protecoes minimas — melhor recusar o boot do que descobrir depois que
 * os dados fiscais estavam em claro.
 */
function verificarProducao(): void {
  if (!ehProducao()) return;

  const problemas: string[] = [];

  if (!config.seguranca.chaveCriptografia) {
    problemas.push('CHAVE_CRIPTOGRAFIA ausente (criptografia em repouso — secao 8)');
  }
  if (!config.whatsapp.segredoWebhook) {
    problemas.push('DISPARAIA_WEBHOOK_SECRET ausente (webhook sem verificacao de assinatura)');
  }
  if (!config.banco.url) {
    problemas.push('DATABASE_URL ausente');
  }
  if (!usandoRedis()) {
    problemas.push('REDIS_URL ausente (a fila cairia para o modo inline em producao)');
  }

  if (problemas.length > 0) {
    throw new Error(
      `Configuracao inadequada para producao:\n  - ${problemas.join('\n  - ')}`,
    );
  }

  if (!config.simulacao.motorValidado) {
    log.warn(
      'MOTOR_VALIDADO=false em producao: as simulacoes serao recusadas ate a ' +
        'revisao por contador/tributarista (secao 6). A API sobe, mas nao simula.',
    );
  }
}

async function iniciar(): Promise<void> {
  verificarProducao();

  const app = await construirApp();

  // Sem Redis, os workers rodam inline no processo da API.
  iniciarWorkers();

  await app.listen({ port: config.porta, host: '0.0.0.0' });

  log.info('Copiloto da Reforma no ar', {
    porta: config.porta,
    ambiente: config.ambiente,
    fila: usandoRedis() ? 'bullmq' : 'inline',
    motorValidado: config.simulacao.motorValidado,
  });

  const encerrar = async (sinal: string): Promise<void> => {
    log.info('Encerrando', { sinal });
    await app.close();
    await fecharFilas();
    await fecharPool().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void encerrar('SIGTERM'));
  process.on('SIGINT', () => void encerrar('SIGINT'));
}

if (require.main === module) {
  iniciar().catch((erro) => {
    log.error('Falha ao iniciar', { erro: (erro as Error).message });
    console.error(erro);
    process.exit(1);
  });
}
