import { config } from '../config';
import { log } from '../comum/log';

/**
 * Cliente da API interna do DisparaIA (secao 5.3).
 *
 * O DisparaIA ja processa WhatsApp em producao; aqui so consumimos o envio.
 * Sem DISPARAIA_URL configurada, as mensagens vao para o log em vez de sumir
 * — e o que permite exercitar o fluxo inteiro em desenvolvimento.
 */

export interface Anexo {
  nomeArquivo: string;
  conteudo: Buffer;
  tipoConteudo: string;
}

export interface ClienteWhatsapp {
  enviarTexto(numero: string, texto: string): Promise<void>;
  enviarAnexo(numero: string, texto: string, anexo: Anexo): Promise<void>;
}

class ClienteDisparaIA implements ClienteWhatsapp {
  async enviarTexto(numero: string, texto: string): Promise<void> {
    await this.postar('/mensagens', { numero, texto });
  }

  async enviarAnexo(numero: string, texto: string, anexo: Anexo): Promise<void> {
    await this.postar('/mensagens/anexo', {
      numero,
      texto,
      arquivo: {
        nome: anexo.nomeArquivo,
        tipo: anexo.tipoConteudo,
        conteudoBase64: anexo.conteudo.toString('base64'),
      },
    });
  }

  private async postar(caminho: string, corpo: unknown): Promise<void> {
    const resposta = await fetch(`${config.whatsapp.urlEnvio}${caminho}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.whatsapp.token}`,
      },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resposta.ok) {
      const detalhe = await resposta.text().catch(() => '');
      throw new Error(
        `DisparaIA respondeu ${resposta.status} em ${caminho}: ${detalhe.slice(0, 200)}`,
      );
    }
  }
}

/** Sem credenciais configuradas: registra no log em vez de enviar. */
class ClienteLog implements ClienteWhatsapp {
  async enviarTexto(numero: string, texto: string): Promise<void> {
    log.info('[whatsapp:simulado] texto', { numero, chars: texto.length });
    console.log(`\n--- mensagem para ${numero} ---\n${texto}\n---\n`);
  }

  async enviarAnexo(numero: string, texto: string, anexo: Anexo): Promise<void> {
    log.info('[whatsapp:simulado] anexo', {
      numero,
      arquivo: anexo.nomeArquivo,
      bytes: anexo.conteudo.length,
    });
    console.log(`\n--- mensagem para ${numero} (anexo ${anexo.nomeArquivo}) ---\n${texto}\n---\n`);
  }
}

let instancia: ClienteWhatsapp | null = null;

export function obterClienteWhatsapp(): ClienteWhatsapp {
  if (instancia) return instancia;
  instancia = config.whatsapp.urlEnvio ? new ClienteDisparaIA() : new ClienteLog();
  return instancia;
}

/** Injecao para testes. */
export function definirClienteWhatsapp(cliente: ClienteWhatsapp | null): void {
  instancia = cliente;
}
