import crypto from 'node:crypto';
import { config, ehProducao } from '../config';

/**
 * Criptografia em repouso para os dados fiscais de terceiros (secao 8).
 *
 * As colunas simulacoes.dados_entrada e simulacoes.resultado guardam dados
 * fiscais dos clientes dos escritorios. Elas nunca recebem o JSON em claro:
 * recebem o envelope abaixo, e a aplicacao decifra sob demanda.
 *
 * AES-256-GCM: cifra e autentica. Se o ciphertext for adulterado no banco, a
 * decifragem falha em vez de devolver dado corrompido silenciosamente.
 */

const ALGORITMO = 'aes-256-gcm';
const TAMANHO_IV = 12; // 96 bits, recomendado para GCM
const VERSAO_ENVELOPE = 1;

export interface EnvelopeCifrado {
  v: number;
  alg: string;
  iv: string;
  tag: string;
  ct: string;
}

let chaveCache: Buffer | null = null;

/**
 * Deriva a chave de 32 bytes a partir de CHAVE_CRIPTOGRAFIA (base64 ou hex).
 *
 * Em desenvolvimento/teste, sem chave configurada, usa uma chave efemera de
 * processo: permite rodar os testes sem setup, e o dado nao sobrevive ao
 * restart — que e exatamente o que se quer de dado de brincadeira. Em
 * producao a ausencia da chave e erro fatal.
 */
export function obterChave(): Buffer {
  if (chaveCache) return chaveCache;

  const bruta = config.seguranca.chaveCriptografia;
  if (!bruta) {
    if (ehProducao()) {
      throw new Error(
        'CHAVE_CRIPTOGRAFIA nao configurada. O piloto nao pode gravar dados ' +
          'fiscais de terceiros sem criptografia em repouso (secao 8).',
      );
    }
    chaveCache = crypto.randomBytes(32);
    return chaveCache;
  }

  const buffer = /^[0-9a-fA-F]{64}$/.test(bruta)
    ? Buffer.from(bruta, 'hex')
    : Buffer.from(bruta, 'base64');

  if (buffer.length !== 32) {
    throw new Error(
      `CHAVE_CRIPTOGRAFIA deve ter 32 bytes (256 bits); recebeu ${buffer.length}. ` +
        'Gere uma com: openssl rand -base64 32',
    );
  }

  chaveCache = buffer;
  return chaveCache;
}

/** Limpa o cache da chave — usado nos testes ao trocar de configuracao. */
export function resetarChave(): void {
  chaveCache = null;
}

export function cifrar(valor: unknown): EnvelopeCifrado {
  const iv = crypto.randomBytes(TAMANHO_IV);
  const cipher = crypto.createCipheriv(ALGORITMO, obterChave(), iv);
  const texto = Buffer.from(JSON.stringify(valor), 'utf8');
  const ct = Buffer.concat([cipher.update(texto), cipher.final()]);

  return {
    v: VERSAO_ENVELOPE,
    alg: ALGORITMO,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

export function decifrar<T = unknown>(envelope: EnvelopeCifrado): T {
  if (!ehEnvelopeCifrado(envelope)) {
    throw new Error('Envelope cifrado invalido ou em formato desconhecido.');
  }

  const decipher = crypto.createDecipheriv(
    ALGORITMO,
    obterChave(),
    Buffer.from(envelope.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));

  const texto = Buffer.concat([
    decipher.update(Buffer.from(envelope.ct, 'base64')),
    decipher.final(),
  ]).toString('utf8');

  return JSON.parse(texto) as T;
}

export function ehEnvelopeCifrado(valor: unknown): valor is EnvelopeCifrado {
  if (typeof valor !== 'object' || valor === null) return false;
  const e = valor as Record<string, unknown>;
  return (
    typeof e.v === 'number' &&
    typeof e.alg === 'string' &&
    typeof e.iv === 'string' &&
    typeof e.tag === 'string' &&
    typeof e.ct === 'string'
  );
}

/**
 * Gera uma API key de escritorio (secao 7) e o hash que vai para o banco.
 * A chave em claro so existe neste retorno — depois disso, so o hash.
 */
export function gerarApiKey(): { chave: string; hash: string } {
  const chave = `cr_${crypto.randomBytes(24).toString('base64url')}`;
  return { chave, hash: hashApiKey(chave) };
}

export function hashApiKey(chave: string): string {
  return crypto.createHash('sha256').update(chave, 'utf8').digest('hex');
}

/** Comparacao em tempo constante, para nao vazar o prefixo por timing. */
export function comparaSegredo(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Mascara um CNPJ para log: 12345678000190 -> **.***.678/0001-** */
export function mascararCnpj(cnpj: string): string {
  const d = cnpj.replace(/\D/g, '');
  if (d.length !== 14) return '***';
  return `**.***.${d.slice(5, 8)}/${d.slice(8, 12)}-**`;
}
