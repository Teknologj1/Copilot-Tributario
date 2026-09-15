import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { config } from '../config';
import { escritorios, type Escritorio } from '../db/repositorios';
import { ErroNaoAutorizado } from '../comum/erros';

/**
 * Autenticacao do piloto (secao 7): uma API key por escritorio.
 * OAuth2 fica para quando o produto sair do piloto.
 */

declare module 'fastify' {
  interface FastifyRequest {
    escritorio?: Escritorio;
  }
}

function extrairChave(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const alternativo = req.headers['x-api-key'];
  if (typeof alternativo === 'string' && alternativo.trim()) return alternativo.trim();
  return null;
}

export async function autenticar(req: FastifyRequest): Promise<Escritorio> {
  const chave = extrairChave(req);
  if (!chave) throw new ErroNaoAutorizado('Informe a API key do escritorio.');

  const escritorio = await escritorios.porApiKey(chave);
  if (!escritorio) throw new ErroNaoAutorizado();

  req.escritorio = escritorio;
  return escritorio;
}

/**
 * Valida a assinatura HMAC do webhook do DisparaIA.
 *
 * Sem DISPARAIA_WEBHOOK_SECRET configurado a verificacao e pulada — aceitavel
 * em desenvolvimento, inaceitavel em producao. O boot avisa (ver server.ts).
 */
export function assinaturaWebhookValida(corpoBruto: Buffer, assinatura?: string): boolean {
  if (!config.whatsapp.segredoWebhook) return true;
  if (!assinatura) return false;

  const esperada = crypto
    .createHmac('sha256', config.whatsapp.segredoWebhook)
    .update(corpoBruto)
    .digest('hex');

  const recebida = assinatura.replace(/^sha256=/, '');

  const a = Buffer.from(esperada, 'utf8');
  const b = Buffer.from(recebida, 'utf8');
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}
