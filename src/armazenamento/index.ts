import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config';
import { log } from '../comum/log';

/**
 * Armazenamento de arquivos: XMLs recebidos e laudos gerados.
 *
 * Driver 'local' para desenvolvimento e teste; 's3' para producao (sa-east-1,
 * mesma conta do DisparaIA). A interface e a mesma dos dois lados, entao o
 * pipeline nao sabe em qual esta rodando.
 */

export interface ArquivoArmazenado {
  /** Chave/caminho logico — e o que vai para o banco. */
  chave: string;
  tamanho: number;
}

export interface Armazenamento {
  salvar(chave: string, conteudo: Buffer, tipoConteudo: string): Promise<ArquivoArmazenado>;
  obter(chave: string): Promise<Buffer>;
  remover(chave: string): Promise<void>;
  existe(chave: string): Promise<boolean>;
}

// --------------------------------------------------------------------------
// Driver local (disco)
// --------------------------------------------------------------------------

class ArmazenamentoLocal implements Armazenamento {
  constructor(private readonly raiz: string) {}

  /**
   * Resolve a chave dentro da raiz e recusa qualquer coisa que escape dela.
   * A chave pode vir de dado externo; sem esta checagem, "../../etc/x" viraria
   * escrita fora do diretorio.
   */
  private caminho(chave: string): string {
    const destino = path.resolve(this.raiz, chave);
    const raiz = path.resolve(this.raiz);
    if (destino !== raiz && !destino.startsWith(raiz + path.sep)) {
      throw new Error(`Chave de armazenamento invalida: ${chave}`);
    }
    return destino;
  }

  async salvar(chave: string, conteudo: Buffer): Promise<ArquivoArmazenado> {
    const destino = this.caminho(chave);
    await fs.mkdir(path.dirname(destino), { recursive: true });
    await fs.writeFile(destino, conteudo);
    return { chave, tamanho: conteudo.length };
  }

  async obter(chave: string): Promise<Buffer> {
    return fs.readFile(this.caminho(chave));
  }

  async remover(chave: string): Promise<void> {
    await fs.rm(this.caminho(chave), { force: true });
  }

  async existe(chave: string): Promise<boolean> {
    try {
      await fs.access(this.caminho(chave));
      return true;
    } catch {
      return false;
    }
  }
}

// --------------------------------------------------------------------------
// Driver S3
// --------------------------------------------------------------------------

/**
 * O SDK da AWS e carregado sob demanda para nao virar dependencia obrigatoria
 * de quem so quer rodar o piloto local. Instalar com:
 *   npm install @aws-sdk/client-s3
 */
class ArmazenamentoS3 implements Armazenamento {
  private cliente: unknown;

  constructor(
    private readonly bucket: string,
    private readonly regiao: string,
  ) {}

  private async sdk(): Promise<Record<string, any>> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('@aws-sdk/client-s3');
    } catch {
      throw new Error(
        'ARMAZENAMENTO_DRIVER=s3 exige o pacote @aws-sdk/client-s3. ' +
          'Rode: npm install @aws-sdk/client-s3',
      );
    }
  }

  private async obterCliente(): Promise<any> {
    if (this.cliente) return this.cliente;
    const { S3Client } = await this.sdk();
    this.cliente = new S3Client({ region: this.regiao });
    return this.cliente;
  }

  async salvar(
    chave: string,
    conteudo: Buffer,
    tipoConteudo: string,
  ): Promise<ArquivoArmazenado> {
    const { PutObjectCommand } = await this.sdk();
    const cliente = await this.obterCliente();
    await cliente.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: chave,
        Body: conteudo,
        ContentType: tipoConteudo,
        // Criptografia no lado do servidor: exigencia da secao 8 para os
        // arquivos fiscais, equivalente ao que fazemos nas colunas do banco.
        ServerSideEncryption: 'AES256',
      }),
    );
    return { chave, tamanho: conteudo.length };
  }

  async obter(chave: string): Promise<Buffer> {
    const { GetObjectCommand } = await this.sdk();
    const cliente = await this.obterCliente();
    const resposta = await cliente.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: chave }),
    );
    const pedacos: Buffer[] = [];
    for await (const pedaco of resposta.Body as AsyncIterable<Buffer>) {
      pedacos.push(pedaco);
    }
    return Buffer.concat(pedacos);
  }

  async remover(chave: string): Promise<void> {
    const { DeleteObjectCommand } = await this.sdk();
    const cliente = await this.obterCliente();
    await cliente.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: chave }));
  }

  async existe(chave: string): Promise<boolean> {
    const { HeadObjectCommand } = await this.sdk();
    const cliente = await this.obterCliente();
    try {
      await cliente.send(new HeadObjectCommand({ Bucket: this.bucket, Key: chave }));
      return true;
    } catch {
      return false;
    }
  }
}

let instancia: Armazenamento | null = null;

export function obterArmazenamento(): Armazenamento {
  if (instancia) return instancia;

  if (config.armazenamento.driver === 's3') {
    if (!config.armazenamento.bucketS3) {
      throw new Error('ARMAZENAMENTO_DRIVER=s3 exige S3_BUCKET configurado.');
    }
    instancia = new ArmazenamentoS3(
      config.armazenamento.bucketS3,
      config.armazenamento.regiao,
    );
  } else {
    log.info('Armazenamento local em uso', { dir: config.armazenamento.diretorioLocal });
    instancia = new ArmazenamentoLocal(config.armazenamento.diretorioLocal);
  }

  return instancia;
}

/** Permite injetar um driver falso nos testes. */
export function definirArmazenamento(driver: Armazenamento | null): void {
  instancia = driver;
}

// --------------------------------------------------------------------------
// Convencao de chaves
// --------------------------------------------------------------------------

function sufixoAleatorio(): string {
  return crypto.randomBytes(6).toString('hex');
}

export function chaveArquivoFiscal(escritorioId: string, extensao = 'xml'): string {
  const agora = new Date();
  const mes = `${agora.getUTCFullYear()}-${String(agora.getUTCMonth() + 1).padStart(2, '0')}`;
  return `fiscal/${escritorioId}/${mes}/${Date.now()}-${sufixoAleatorio()}.${extensao}`;
}

export function chaveLaudo(simulacaoId: string): string {
  return `laudos/${simulacaoId}.pdf`;
}
