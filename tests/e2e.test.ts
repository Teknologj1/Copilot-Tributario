import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import {
  criarBancoMemoria,
  ArmazenamentoMemoria,
  WhatsappMemoria,
  type BancoMemoria,
} from './apoio/fakes';

/**
 * Teste de ponta a ponta do piloto (criterios de aceite da secao 10):
 * XML chega pelo WhatsApp -> parse -> simulacao -> laudo em PDF -> resposta
 * com o anexo. Banco, armazenamento e WhatsApp sao dubles; o resto e o
 * pipeline real, rodando na fila em modo inline (sem Redis).
 */

const banco: BancoMemoria = criarBancoMemoria();

vi.mock('../src/db/repositorios', () => ({
  get escritorios() { return banco.escritorios; },
  get empresas() { return banco.empresas; },
  get simulacoes() { return banco.simulacoes; },
  get mensagens() { return banco.mensagens; },
  get conversas() { return banco.conversas; },
}));

vi.mock('../src/db/auditoria', () => ({
  get registrar() { return banco.auditoria.registrar; },
}));

// Os getters acima adiam o acesso a `banco` ate a chamada em tempo de teste,
// entao os imports estaticos convivem com o hoisting do vi.mock.
import { tratarMensagem } from '../src/intake/handler';
import { definirArmazenamento } from '../src/armazenamento';
import { definirClienteWhatsapp } from '../src/intake/disparaia';
import '../src/fila/processadores'; // registra o processador na fila inline

const NUMERO = '+5511999990000';
const xmlLote = fs.readFileSync(path.join(__dirname, 'fixtures', 'nfe-lote.xml'));

let armazenamento: ArmazenamentoMemoria;
let whatsapp: WhatsappMemoria;
let escritorioId: string;

beforeEach(async () => {
  banco.estado.escritorios.length = 0;
  banco.estado.empresas.length = 0;
  banco.estado.simulacoes.length = 0;
  banco.estado.mensagens.length = 0;
  banco.estado.auditoria.length = 0;
  banco.estado.conversas.clear();

  armazenamento = new ArmazenamentoMemoria();
  whatsapp = new WhatsappMemoria();
  definirArmazenamento(armazenamento);
  definirClienteWhatsapp(whatsapp);

  const escritorio = await banco.escritorios.criar({
    nome: 'Escritorio Piloto',
    cnpj: '12345678000195',
    whatsappNumero: NUMERO,
  });
  escritorioId = escritorio.id;
});

function anexoXml() {
  return { nomeArquivo: 'notas.xml', tipoConteudo: 'application/xml', conteudo: xmlLote };
}

describe('fluxo completo: XML -> laudo em PDF no WhatsApp', () => {
  it('pede o anexo do Simples antes de simular, e nao chuta', async () => {
    await tratarMensagem({ de: NUMERO, anexo: anexoXml(), mensagemId: 'm1' });

    const textos = whatsapp.enviadas.map((m) => m.texto).join('\n');
    expect(textos).toMatch(/Recebi o arquivo/);
    expect(textos).toMatch(/Anexo do Simples Nacional/i);

    // Leu o XML e mostrou o que entendeu antes de perguntar.
    expect(textos).toMatch(/PADARIA MODELO LTDA/);
    expect(textos).toMatch(/73\.3% B2B/);

    // Nada foi simulado ainda.
    expect(banco.estado.simulacoes).toHaveLength(0);
    expect(banco.estado.conversas.get(escritorioId)?.estado).toBe('confirmando_campos');
  });

  it('responde o anexo e entao entrega a simulacao com o laudo anexo', async () => {
    await tratarMensagem({ de: NUMERO, anexo: anexoXml(), mensagemId: 'm1' });
    whatsapp.limpar();

    await tratarMensagem({ de: NUMERO, texto: 'anexo 1', mensagemId: 'm2' });
    await tratarMensagem({ de: NUMERO, texto: '400 mil', mensagemId: 'm3' });

    // Uma simulacao foi criada e a empresa saiu de 'pendente'.
    expect(banco.estado.simulacoes).toHaveLength(1);
    const simulacao = banco.estado.simulacoes[0]!;
    expect(simulacao.resultado.recomendacao).toMatch(/dentro_das|fora_das/);
    expect(banco.estado.empresas[0]!.status_decisao).toBe('simulado');

    // O laudo chegou anexado na conversa.
    const comAnexo = whatsapp.comAnexo;
    expect(comAnexo).toHaveLength(1);

    const anexo = comAnexo[0]!.anexo!;
    expect(anexo.tipoConteudo).toBe('application/pdf');
    expect(anexo.nomeArquivo).toMatch(/^laudo-12345678000195-\d{4}-\d{2}\.pdf$/);
    expect(anexo.conteudo.subarray(0, 5).toString()).toBe('%PDF-');

    const pdf = await PDFDocument.load(anexo.conteudo);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);

    // O texto que acompanha traz a recomendacao e o aviso de provisorio.
    expect(comAnexo[0]!.texto).toMatch(/PADARIA MODELO LTDA/);
    expect(comAnexo[0]!.texto).toMatch(/provisoria/i);
  });

  it('o laudo fica armazenado e vinculado a simulacao', async () => {
    await tratarMensagem({ de: NUMERO, anexo: anexoXml(), mensagemId: 'm1' });
    await tratarMensagem({ de: NUMERO, texto: 'I', mensagemId: 'm2' });
    await tratarMensagem({ de: NUMERO, texto: 'pular', mensagemId: 'm3' });

    const simulacao = banco.estado.simulacoes[0]!;
    expect(simulacao.laudoPdfUrl).toBe(`laudos/${simulacao.id}.pdf`);
    expect(await armazenamento.existe(simulacao.laudoPdfUrl!)).toBe(true);
  });

  it('registra a anualizacao extrapolada nas premissas do laudo', async () => {
    await tratarMensagem({ de: NUMERO, anexo: anexoXml(), mensagemId: 'm1' });
    await tratarMensagem({ de: NUMERO, texto: 'I', mensagemId: 'm2' });
    await tratarMensagem({ de: NUMERO, texto: 'pular', mensagemId: 'm3' });

    const observacoes = banco.estado.simulacoes[0]!.resultado.observacoes.join(' ');
    expect(observacoes).toMatch(/extrapolado a partir de 2 mes/i);
  });

  it('guarda a chave do XML para permitir re-simular depois', async () => {
    await tratarMensagem({ de: NUMERO, anexo: anexoXml(), mensagemId: 'm1' });
    await tratarMensagem({ de: NUMERO, texto: 'I', mensagemId: 'm2' });
    await tratarMensagem({ de: NUMERO, texto: 'pular', mensagemId: 'm3' });

    const chave = banco.estado.simulacoes[0]!.dadosEntrada.chaveArquivo;
    expect(chave).toBeTruthy();
    expect(await armazenamento.existe(chave)).toBe(true);
  });

  it('aceita folha e compras informadas no chat', async () => {
    await tratarMensagem({ de: NUMERO, anexo: anexoXml(), mensagemId: 'm1' });
    await tratarMensagem({ de: NUMERO, texto: 'anexo III', mensagemId: 'm2' });
    await tratarMensagem({ de: NUMERO, texto: '300 mil', mensagemId: 'm3' });
    await tratarMensagem({ de: NUMERO, texto: '400.000,00', mensagemId: 'm4' });


    expect(banco.estado.simulacoes).toHaveLength(1);
    const entrada = banco.estado.simulacoes[0]!.dadosEntrada;
    expect(entrada.folhaSalarios12m).toBe(300000);
    expect(entrada.comprasComCredito).toBe(400000);

    // Folha de 300k sobre 900k anualizado = Fator R 33% -> Anexo III.
    expect(banco.estado.simulacoes[0]!.resultado.observacoes.join(' ')).toMatch(/Fator R/);
  });

  it('repergunta quando a resposta nao e compreendida, em vez de assumir zero', async () => {
    await tratarMensagem({ de: NUMERO, anexo: anexoXml(), mensagemId: 'm1' });
    whatsapp.limpar();

    await tratarMensagem({ de: NUMERO, texto: 'sei la, anexo qualquer', mensagemId: 'm2' });

    expect(whatsapp.ultima?.texto).toMatch(/Nao consegui entender/i);
    expect(banco.estado.simulacoes).toHaveLength(0);
  });

  it('nao deixa pular um campo obrigatorio', async () => {
    await tratarMensagem({ de: NUMERO, anexo: anexoXml(), mensagemId: 'm1' });
    whatsapp.limpar();

    await tratarMensagem({ de: NUMERO, texto: 'pular', mensagemId: 'm2' });

    expect(whatsapp.ultima?.texto).toMatch(/nao consigo dispensar/i);
    expect(banco.estado.simulacoes).toHaveLength(0);
  });

  it('permite pular os campos opcionais e ainda assim simular', async () => {
    await tratarMensagem({ de: NUMERO, anexo: anexoXml(), mensagemId: 'm1' });
    await tratarMensagem({ de: NUMERO, texto: 'I', mensagemId: 'm2' });
    await tratarMensagem({ de: NUMERO, texto: 'pular', mensagemId: 'm3' });

    expect(banco.estado.simulacoes).toHaveLength(1);
    const entrada = banco.estado.simulacoes[0]!.dadosEntrada;
    expect(entrada.comprasComCredito).toBeUndefined();
    // Dado faltante mantem a confianca la embaixo.
    expect(banco.estado.simulacoes[0]!.confianca).toBe('baixa');
  });

  it('nao pergunta a folha para Anexo I, onde o Fator R nao se aplica', async () => {
    await tratarMensagem({ de: NUMERO, anexo: anexoXml(), mensagemId: 'm1' });
    whatsapp.limpar();
    await tratarMensagem({ de: NUMERO, texto: 'I', mensagemId: 'm2' });

    const textos = whatsapp.enviadas.map((m) => m.texto).join('\n');
    expect(textos).not.toMatch(/folha de salarios/i);
    expect(textos).toMatch(/credito de IBS\/CBS/i);
  });
});

describe('idempotencia e erros', () => {
  it('ignora reentrega da mesma mensagem', async () => {
    const r1 = await tratarMensagem({ de: NUMERO, anexo: anexoXml(), mensagemId: 'repetida' });
    const r2 = await tratarMensagem({ de: NUMERO, anexo: anexoXml(), mensagemId: 'repetida' });

    expect(r1.duplicada).toBe(false);
    expect(r2.duplicada).toBe(true);
    expect(banco.estado.mensagens).toHaveLength(1);
  });

  it('recusa numero nao cadastrado', async () => {
    const r = await tratarMensagem({ de: '+5511000000000', texto: 'oi' });
    expect(r.resposta).toMatch(/nao encontrei um escritorio cadastrado/i);
    expect(banco.estado.mensagens).toHaveLength(0);
  });

  it('explica que PDF de PGDAS ainda nao e lido', async () => {
    const r = await tratarMensagem({
      de: NUMERO,
      anexo: { nomeArquivo: 'pgdas.pdf', tipoConteudo: 'application/pdf', conteudo: Buffer.from('%PDF-1.4') },
      mensagemId: 'm-pdf',
    });

    expect(r.resposta).toMatch(/apenas o \*XML\*/i);
    expect(r.resposta).toMatch(/PGDAS e SPED/i);
  });

  it('avisa o contador quando o XML e ilegivel e marca a mensagem como erro', async () => {
    await tratarMensagem({
      de: NUMERO,
      anexo: { nomeArquivo: 'lixo.xml', tipoConteudo: 'application/xml', conteudo: Buffer.from('<nada/>') },
      mensagemId: 'm-ruim',
    });

    const textos = whatsapp.enviadas.map((m) => m.texto).join('\n');
    expect(textos).toMatch(/Nao consegui processar/i);
    expect(textos).toMatch(/Nenhuma NF-e/i);
    expect(banco.estado.mensagens[0]!.status).toBe('erro');
  });
});

describe('comandos de conversa', () => {
  it('responde a triagem de portfolio', async () => {
    await banco.empresas.garantir({
      escritorioId,
      cnpj: '98765432000198',
      razaoSocial: 'CLIENTE PENDENTE LTDA',
      prazoDecisao: new Date('2026-11-30'),
    });

    const r = await tratarMensagem({ de: NUMERO, texto: 'pendentes', mensagemId: 'm-pend' });

    expect(r.resposta).toMatch(/1 empresa\* pendente/);
    expect(r.resposta).toMatch(/CLIENTE PENDENTE LTDA/);
    expect(r.resposta).toMatch(/98\.765\.432\/0001-98/);
  });

  it('mostra a ajuda para mensagem solta', async () => {
    const r = await tratarMensagem({ de: NUMERO, texto: 'bom dia', mensagemId: 'm-oi' });
    expect(r.resposta).toMatch(/Copiloto da Reforma/);
    expect(r.resposta).toMatch(/pendentes/);
  });

  it('recusa CNPJ com digito verificador errado', async () => {
    const r = await tratarMensagem({
      de: NUMERO,
      texto: 'simular 12.345.678/0001-90',
      mensagemId: 'm-cnpj',
    });
    expect(r.resposta).toMatch(/nao parece valido/i);
  });

  it('pede o XML quando a empresa ainda nao tem dados', async () => {
    const r = await tratarMensagem({
      de: NUMERO,
      texto: 'simular 98.765.432/0001-98',
      mensagemId: 'm-nova',
    });
    expect(r.resposta).toMatch(/XML das notas fiscais/i);
  });

  it('cancela o atendimento e volta ao estado ocioso', async () => {
    await tratarMensagem({ de: NUMERO, anexo: anexoXml(), mensagemId: 'm1' });
    const r = await tratarMensagem({ de: NUMERO, texto: 'cancelar', mensagemId: 'm-cancel' });

    expect(r.resposta).toMatch(/cancelado/i);
    expect(banco.estado.conversas.get(escritorioId)?.estado).toBe('ocioso');
  });
});

describe('trilha de auditoria (secao 8)', () => {
  it('registra recebimento, simulacao, geracao e envio do laudo', async () => {
    await tratarMensagem({ de: NUMERO, anexo: anexoXml(), mensagemId: 'm1' });
    await tratarMensagem({ de: NUMERO, texto: 'I', mensagemId: 'm2' });
    await tratarMensagem({ de: NUMERO, texto: 'pular', mensagemId: 'm3' });

    const acoes = banco.estado.auditoria.map((a: any) => a.acao);
    expect(acoes).toContain('mensagem.recebida');
    expect(acoes).toContain('simulacao.criada');
    expect(acoes).toContain('laudo.gerado');
    expect(acoes).toContain('laudo.enviado');
  });

  it('registra a falha quando o processamento quebra', async () => {
    await tratarMensagem({
      de: NUMERO,
      anexo: { nomeArquivo: 'x.xml', tipoConteudo: 'application/xml', conteudo: Buffer.from('<nada/>') },
      mensagemId: 'm-erro',
    });

    const falha = banco.estado.auditoria.find((a: any) => a.acao === 'simulacao.falhou');
    expect(falha).toBeDefined();
    expect(falha.detalhe.dominio).toBe(true);
  });
});
