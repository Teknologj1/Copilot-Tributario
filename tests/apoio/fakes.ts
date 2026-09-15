import { vi } from 'vitest';
import type { Armazenamento } from '../../src/armazenamento';
import type { ClienteWhatsapp, Anexo } from '../../src/intake/disparaia';

/**
 * Dubles em memoria para o teste de ponta a ponta. Substituem banco,
 * armazenamento e WhatsApp — o resto do pipeline roda de verdade.
 */

export class ArmazenamentoMemoria implements Armazenamento {
  readonly arquivos = new Map<string, Buffer>();

  async salvar(chave: string, conteudo: Buffer) {
    this.arquivos.set(chave, conteudo);
    return { chave, tamanho: conteudo.length };
  }
  async obter(chave: string) {
    const c = this.arquivos.get(chave);
    if (!c) throw new Error(`arquivo nao encontrado: ${chave}`);
    return c;
  }
  async remover(chave: string) {
    this.arquivos.delete(chave);
  }
  async existe(chave: string) {
    return this.arquivos.has(chave);
  }
}

export interface MensagemEnviada {
  numero: string;
  texto: string;
  anexo?: Anexo;
}

export class WhatsappMemoria implements ClienteWhatsapp {
  readonly enviadas: MensagemEnviada[] = [];

  async enviarTexto(numero: string, texto: string) {
    this.enviadas.push({ numero, texto });
  }
  async enviarAnexo(numero: string, texto: string, anexo: Anexo) {
    this.enviadas.push({ numero, texto, anexo });
  }

  get ultima(): MensagemEnviada | undefined {
    return this.enviadas[this.enviadas.length - 1];
  }
  get comAnexo(): MensagemEnviada[] {
    return this.enviadas.filter((m) => m.anexo);
  }
  limpar() {
    this.enviadas.length = 0;
  }
}

let contador = 0;
const novoId = (prefixo: string) => `${prefixo}-${++contador}`;

/** Banco em memoria com a mesma superficie dos repositorios reais. */
export function criarBancoMemoria() {
  const estado = {
    escritorios: [] as any[],
    empresas: [] as any[],
    simulacoes: [] as any[],
    mensagens: [] as any[],
    conversas: new Map<string, any>(),
    auditoria: [] as any[],
  };

  const escritorios = {
    porId: vi.fn(async (id: string) => estado.escritorios.find((e) => e.id === id) ?? null),
    porWhatsapp: vi.fn(
      async (n: string) => estado.escritorios.find((e) => e.whatsapp_numero === n) ?? null,
    ),
    porApiKey: vi.fn(async () => null),
    criar: vi.fn(async (d: any) => {
      const e = {
        id: novoId('esc'),
        nome: d.nome,
        cnpj: d.cnpj,
        whatsapp_numero: d.whatsappNumero,
        plano: d.plano ?? 'piloto',
        criado_em: new Date(),
      };
      estado.escritorios.push(e);
      return e;
    }),
    definirApiKeyHash: vi.fn(async () => undefined),
  };

  const empresas = {
    porId: vi.fn(async (id: string) => estado.empresas.find((e) => e.id === id) ?? null),
    porCnpj: vi.fn(
      async (escId: string, cnpj: string) =>
        estado.empresas.find((e) => e.escritorio_id === escId && e.cnpj === cnpj) ?? null,
    ),
    pendentes: vi.fn(async (escId: string) =>
      estado.empresas.filter((e) => e.escritorio_id === escId && e.status_decisao === 'pendente'),
    ),
    porStatus: vi.fn(async (escId: string, s: string) =>
      estado.empresas.filter((e) => e.escritorio_id === escId && e.status_decisao === s),
    ),
    listar: vi.fn(async (escId: string) =>
      estado.empresas.filter((e) => e.escritorio_id === escId),
    ),
    garantir: vi.fn(async (d: any) => {
      const existente = estado.empresas.find(
        (e) => e.escritorio_id === d.escritorioId && e.cnpj === d.cnpj,
      );
      if (existente) {
        existente.anexo_simples = d.anexoSimples ?? existente.anexo_simples;
        existente.uf = d.uf ?? existente.uf;
        return existente;
      }
      const nova = {
        id: novoId('emp'),
        escritorio_id: d.escritorioId,
        cnpj: d.cnpj,
        razao_social: d.razaoSocial,
        anexo_simples: d.anexoSimples ?? null,
        uf: d.uf ?? null,
        status_decisao: 'pendente',
        prazo_decisao: d.prazoDecisao ?? null,
        criado_em: new Date(),
      };
      estado.empresas.push(nova);
      return nova;
    }),
    atualizarStatus: vi.fn(async (id: string, status: string) => {
      const e = estado.empresas.find((x) => x.id === id);
      if (e) e.status_decisao = status;
    }),
  };

  const simulacoes = {
    porId: vi.fn(async (id: string) => estado.simulacoes.find((s) => s.id === id) ?? null),
    porIdDoEscritorio: vi.fn(async (id: string, escId: string) => {
      const s = estado.simulacoes.find((x) => x.id === id);
      if (!s) return null;
      const emp = estado.empresas.find((e) => e.id === s.empresaId);
      return emp?.escritorio_id === escId ? s : null;
    }),
    ultimaDaEmpresa: vi.fn(
      async (empresaId: string) =>
        [...estado.simulacoes].reverse().find((s) => s.empresaId === empresaId) ?? null,
    ),
    criar: vi.fn(async (d: any) => {
      const s = {
        id: novoId('sim'),
        empresaId: d.empresaId,
        ciclo: d.ciclo,
        dadosEntrada: d.dadosEntrada,
        resultado: d.resultado,
        recomendacao: d.resultado.recomendacao,
        confianca: d.resultado.confianca,
        motorVersao: d.resultado.versaoMotor,
        laudoPdfUrl: null as string | null,
        criadoEm: new Date(),
      };
      estado.simulacoes.push(s);
      await empresas.atualizarStatus(d.empresaId, 'simulado');
      return s;
    }),
    definirLaudo: vi.fn(async (id: string, url: string) => {
      const s = estado.simulacoes.find((x) => x.id === id);
      if (s) s.laudoPdfUrl = url;
    }),
    expurgarDadosEntradaAnterioresA: vi.fn(async () => 0),
  };

  const mensagens = {
    porId: vi.fn(async (id: string) => estado.mensagens.find((m) => m.id === id) ?? null),
    porOrigem: vi.fn(
      async (escId: string, oid: string) =>
        estado.mensagens.find(
          (m) => m.escritorio_id === escId && m.origem_mensagem_id === oid,
        ) ?? null,
    ),
    registrar: vi.fn(async (d: any) => {
      if (d.origemMensagemId) {
        const existente = estado.mensagens.find(
          (m) => m.escritorio_id === d.escritorioId && m.origem_mensagem_id === d.origemMensagemId,
        );
        if (existente) return { mensagem: existente, jaExistia: true };
      }
      const m = {
        id: novoId('msg'),
        escritorio_id: d.escritorioId,
        tipo_anexo: d.tipoAnexo,
        conteudo_bruto: d.conteudoBruto,
        status: 'recebida',
        erro_detalhe: null,
        origem_mensagem_id: d.origemMensagemId ?? null,
        criado_em: new Date(),
      };
      estado.mensagens.push(m);
      return { mensagem: m, jaExistia: false };
    }),
    atualizarStatus: vi.fn(async (id: string, status: string, erro?: string) => {
      const m = estado.mensagens.find((x) => x.id === id);
      if (m) {
        m.status = status;
        m.erro_detalhe = erro ?? null;
      }
    }),
    anterioresA: vi.fn(async () => []),
    limparConteudoBruto: vi.fn(async () => undefined),
  };

  const conversas = {
    obter: vi.fn(async (escId: string) => estado.conversas.get(escId) ?? null),
    salvar: vi.fn(async (escId: string, estadoConversa: string, contexto: any) => {
      estado.conversas.set(escId, {
        escritorio_id: escId,
        estado: estadoConversa,
        contexto,
        atualizado_em: new Date(),
      });
    }),
  };

  const auditoria = {
    registrar: vi.fn(async (entrada: any) => {
      estado.auditoria.push(entrada);
    }),
  };

  return { estado, escritorios, empresas, simulacoes, mensagens, conversas, auditoria };
}

export type BancoMemoria = ReturnType<typeof criarBancoMemoria>;
