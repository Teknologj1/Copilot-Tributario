/**
 * Configuracao central do piloto. Tudo vem de variaveis de ambiente — ver
 * .env.example. Falha rapido no boot quando falta algo obrigatorio, para nao
 * descobrir em producao que a chave de criptografia nao estava setada.
 */

function obrigatorio(nome: string): string {
  const valor = process.env[nome];
  if (!valor || valor.trim() === '') {
    throw new Error(
      `Variavel de ambiente obrigatoria ausente: ${nome}. Ver .env.example.`,
    );
  }
  return valor;
}

function opcional(nome: string, padrao: string): string {
  const valor = process.env[nome];
  return valor && valor.trim() !== '' ? valor : padrao;
}

function booleano(nome: string, padrao: boolean): boolean {
  const valor = process.env[nome];
  if (valor === undefined || valor.trim() === '') return padrao;
  return ['1', 'true', 'sim', 'yes'].includes(valor.trim().toLowerCase());
}

export type Ambiente = 'desenvolvimento' | 'teste' | 'producao';

export const config = {
  ambiente: opcional('NODE_ENV', 'desenvolvimento') as Ambiente,
  porta: Number(opcional('PORT', '3000')),

  banco: {
    url: opcional('DATABASE_URL', ''),
  },

  redis: {
    // Sem REDIS_URL a fila roda no modo inline (mesmo processo). Util em dev e
    // em teste; em producao o worker separado exige Redis — ver src/fila/fila.ts.
    url: opcional('REDIS_URL', ''),
  },

  seguranca: {
    /**
     * Chave mestra (32 bytes em base64 ou hex) usada para cifrar dados_entrada
     * e resultado em repouso — secao 8 da especificacao.
     */
    chaveCriptografia: opcional('CHAVE_CRIPTOGRAFIA', ''),
    /** Dias de retencao dos arquivos fiscais brutos apos o processamento. */
    retencaoArquivosDias: Number(opcional('RETENCAO_ARQUIVOS_DIAS', '90')),
    /** Dias de retencao dos dados de entrada cifrados das simulacoes. */
    retencaoDadosEntradaDias: Number(opcional('RETENCAO_DADOS_ENTRADA_DIAS', '365')),
  },

  armazenamento: {
    // 'local' (disco, para dev/teste) ou 's3'.
    driver: opcional('ARMAZENAMENTO_DRIVER', 'local'),
    diretorioLocal: opcional('ARMAZENAMENTO_DIR', './armazenamento-local'),
    bucketS3: opcional('S3_BUCKET', ''),
    regiao: opcional('AWS_REGION', 'sa-east-1'),
  },

  whatsapp: {
    /** URL da API interna do DisparaIA para envio de mensagens/anexos. */
    urlEnvio: opcional('DISPARAIA_URL', ''),
    token: opcional('DISPARAIA_TOKEN', ''),
    /** Segredo compartilhado que assina o webhook de entrada. */
    segredoWebhook: opcional('DISPARAIA_WEBHOOK_SECRET', ''),
  },

  simulacao: {
    /**
     * TRAVA DE SEGURANCA PROFISSIONAL (secao 6 + criterio de aceite da secao 10).
     *
     * O motor de calculo so pode rodar em producao depois que as regras forem
     * revisadas por um contador ou tributarista. Enquanto MOTOR_VALIDADO nao
     * for explicitamente 'true', o motor:
     *   - marca todo resultado com confianca 'baixa';
     *   - carimba no laudo que a simulacao e provisoria;
     *   - recusa-se a rodar com NODE_ENV=producao.
     * Ver src/simulacao/motor.ts.
     */
     motorValidado: booleano('MOTOR_VALIDADO', false),
     /** Identificacao de quem validou, quando validado. Vai para o laudo. */
     validadoPor: opcional('MOTOR_VALIDADO_POR', ''),
  },
} as const;

export function ehProducao(): boolean {
  return config.ambiente === 'producao';
}

export { obrigatorio, opcional, booleano };
