import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { formatarCnpj } from '../comum/cnpj';
import type { ResultadoSimulacao } from '../simulacao/interface';
import {
  AVISO_RESPONSABILIDADE,
  TARJA_PROVISORIA,
  moeda,
  montarResumo,
} from './texto';

/**
 * Gerador de laudo em PDF — secao 5.4.
 *
 * pdf-lib em vez de puppeteer: o laudo do piloto e texto mais uma tabela, e
 * nao compensa carregar um Chromium por documento gerado.
 */

const MARGEM = 56;
const LARGURA = 595.28; // A4 retrato
const ALTURA = 841.89;

const TINTA = rgb(0.12, 0.13, 0.15);
const TINTA_SUAVE = rgb(0.42, 0.45, 0.5);
const DESTAQUE = rgb(0.09, 0.35, 0.6);
const ALERTA = rgb(0.72, 0.21, 0.13);
const LINHA = rgb(0.85, 0.87, 0.89);
const FUNDO_CABECALHO = rgb(0.96, 0.97, 0.98);

export interface DadosEmpresaLaudo {
  razaoSocial: string;
  cnpj: string;
  anexoSimples?: string | null;
  uf?: string | null;
}

interface Contexto {
  pdf: PDFDocument;
  pagina: PDFPage;
  y: number;
  regular: PDFFont;
  negrito: PDFFont;
}

/** Quebra o texto na largura util, medindo com a fonte real. */
function quebrarLinhas(
  texto: string,
  fonte: PDFFont,
  tamanho: number,
  largura: number,
): string[] {
  const palavras = texto.split(/\s+/).filter(Boolean);
  const linhas: string[] = [];
  let atual = '';

  for (const palavra of palavras) {
    const tentativa = atual ? `${atual} ${palavra}` : palavra;
    if (fonte.widthOfTextAtSize(tentativa, tamanho) <= largura) {
      atual = tentativa;
    } else {
      if (atual) linhas.push(atual);
      atual = palavra;
    }
  }
  if (atual) linhas.push(atual);
  return linhas;
}

function novaPagina(ctx: Contexto): void {
  ctx.pagina = ctx.pdf.addPage([LARGURA, ALTURA]);
  ctx.y = ALTURA - MARGEM;
}

function garantirEspaco(ctx: Contexto, altura: number): void {
  if (ctx.y - altura < MARGEM + 40) novaPagina(ctx);
}

function escrever(
  ctx: Contexto,
  texto: string,
  opcoes: {
    tamanho?: number;
    fonte?: PDFFont;
    cor?: ReturnType<typeof rgb>;
    espacoDepois?: number;
    x?: number;
  } = {},
): void {
  const tamanho = opcoes.tamanho ?? 10;
  const fonte = opcoes.fonte ?? ctx.regular;
  const x = opcoes.x ?? MARGEM;
  const largura = LARGURA - MARGEM - x;
  const alturaLinha = tamanho * 1.45;

  for (const linha of quebrarLinhas(texto, fonte, tamanho, largura)) {
    garantirEspaco(ctx, alturaLinha);
    ctx.pagina.drawText(linha, {
      x,
      y: ctx.y - tamanho,
      size: tamanho,
      font: fonte,
      color: opcoes.cor ?? TINTA,
    });
    ctx.y -= alturaLinha;
  }

  ctx.y -= opcoes.espacoDepois ?? 0;
}

function regua(ctx: Contexto, espacoDepois = 12): void {
  garantirEspaco(ctx, 10);
  ctx.pagina.drawLine({
    start: { x: MARGEM, y: ctx.y },
    end: { x: LARGURA - MARGEM, y: ctx.y },
    thickness: 0.75,
    color: LINHA,
  });
  ctx.y -= espacoDepois;
}

function caixa(
  ctx: Contexto,
  texto: string,
  cor: ReturnType<typeof rgb>,
  fundo: ReturnType<typeof rgb>,
): void {
  const tamanho = 9.5;
  const linhas = quebrarLinhas(texto, ctx.regular, tamanho, LARGURA - MARGEM * 2 - 20);
  const altura = linhas.length * tamanho * 1.4 + 18;

  garantirEspaco(ctx, altura + 10);

  ctx.pagina.drawRectangle({
    x: MARGEM,
    y: ctx.y - altura,
    width: LARGURA - MARGEM * 2,
    height: altura,
    color: fundo,
    borderColor: cor,
    borderWidth: 0.75,
  });

  let cursor = ctx.y - 14;
  for (const linha of linhas) {
    ctx.pagina.drawText(linha, {
      x: MARGEM + 10,
      y: cursor - tamanho + 4,
      size: tamanho,
      font: ctx.regular,
      color: cor,
    });
    cursor -= tamanho * 1.4;
  }

  ctx.y -= altura + 14;
}

function tabelaProjecao(ctx: Contexto, resultado: ResultadoSimulacao): void {
  const colunas = [
    { titulo: 'Ano', x: MARGEM, largura: 50 },
    { titulo: 'Dentro do DAS', x: MARGEM + 55, largura: 130 },
    { titulo: 'Fora do DAS', x: MARGEM + 195, largura: 130 },
    { titulo: 'Diferenca', x: MARGEM + 335, largura: 148 },
  ];
  const alturaLinha = 22;

  garantirEspaco(ctx, alturaLinha * (resultado.projecaoPorAno.length + 2));

  // Cabecalho
  ctx.pagina.drawRectangle({
    x: MARGEM,
    y: ctx.y - alturaLinha,
    width: LARGURA - MARGEM * 2,
    height: alturaLinha,
    color: FUNDO_CABECALHO,
  });
  for (const coluna of colunas) {
    ctx.pagina.drawText(coluna.titulo, {
      x: coluna.x + 6,
      y: ctx.y - alturaLinha + 7,
      size: 9,
      font: ctx.negrito,
      color: TINTA,
    });
  }
  ctx.y -= alturaLinha;

  for (const ano of resultado.projecaoPorAno) {
    // Diferenca positiva = fora custa mais = ficar dentro compensa.
    const favorecido = ano.diferenca >= 0 ? 'dentro' : 'fora';
    const celulas = [
      String(ano.ano),
      moeda(ano.cargaTributariaDentroDAS),
      moeda(ano.cargaTributariaForaDAS),
      `${moeda(Math.abs(ano.diferenca))} a favor de ${favorecido === 'dentro' ? 'ficar' : 'sair'}`,
    ];

    celulas.forEach((valor, i) => {
      const coluna = colunas[i];
      if (!coluna) return;
      ctx.pagina.drawText(valor, {
        x: coluna.x + 6,
        y: ctx.y - alturaLinha + 7,
        size: 9,
        font: i === 0 ? ctx.negrito : ctx.regular,
        color: i === 3 ? DESTAQUE : TINTA,
      });
    });

    ctx.pagina.drawLine({
      start: { x: MARGEM, y: ctx.y - alturaLinha },
      end: { x: LARGURA - MARGEM, y: ctx.y - alturaLinha },
      thickness: 0.5,
      color: LINHA,
    });
    ctx.y -= alturaLinha;
  }

  ctx.y -= 16;
}

function memoriaDeCalculo(ctx: Contexto, resultado: ResultadoSimulacao): void {
  novaPagina(ctx);
  escrever(ctx, 'Memoria de calculo', { tamanho: 14, fonte: ctx.negrito, espacoDepois: 4 });
  escrever(
    ctx,
    'Detalhamento de como cada valor da tabela foi obtido, para conferencia pelo contador responsavel.',
    { tamanho: 9, cor: TINTA_SUAVE, espacoDepois: 10 },
  );
  regua(ctx);

  const anos = [...new Set(resultado.memoriaCalculo.map((l) => l.ano))].sort();

  for (const ano of anos) {
    escrever(ctx, String(ano), { tamanho: 11, fonte: ctx.negrito, espacoDepois: 4 });

    for (const cenario of ['dentro_das', 'fora_das'] as const) {
      const linhas = resultado.memoriaCalculo.filter(
        (l) => l.ano === ano && l.cenario === cenario,
      );
      if (linhas.length === 0) continue;

      escrever(ctx, cenario === 'dentro_das' ? 'Dentro do DAS' : 'Fora do DAS', {
        tamanho: 9.5,
        fonte: ctx.negrito,
        cor: DESTAQUE,
        espacoDepois: 2,
      });

      for (const linha of linhas) {
        escrever(ctx, `${linha.rubrica}: ${moeda(linha.valor)}`, { tamanho: 9, x: MARGEM + 12 });
        escrever(ctx, linha.formula, {
          tamanho: 8,
          cor: TINTA_SUAVE,
          x: MARGEM + 12,
          espacoDepois: 3,
        });
      }
    }
    ctx.y -= 8;
  }
}

export async function gerarLaudo(
  resultado: ResultadoSimulacao,
  empresa: DadosEmpresaLaudo,
): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const negrito = await pdf.embedFont(StandardFonts.HelveticaBold);

  const ctx: Contexto = {
    pdf,
    pagina: pdf.addPage([LARGURA, ALTURA]),
    y: ALTURA - MARGEM,
    regular,
    negrito,
  };

  const resumo = montarResumo(resultado, empresa);

  // --- Cabecalho ---
  escrever(ctx, 'Copiloto da Reforma', { tamanho: 9, cor: TINTA_SUAVE });
  escrever(ctx, 'Laudo de simulacao — dentro ou fora do DAS', {
    tamanho: 18,
    fonte: negrito,
    espacoDepois: 6,
  });
  regua(ctx);

  // --- Tarja de simulacao provisoria (enquanto o motor nao for validado) ---
  if (!resultado.validadoPorProfissional) {
    caixa(ctx, TARJA_PROVISORIA, ALERTA, rgb(0.99, 0.95, 0.94));
  }

  // --- Identificacao ---
  escrever(ctx, 'Empresa simulada', { tamanho: 11, fonte: negrito, espacoDepois: 2 });
  escrever(ctx, empresa.razaoSocial, { tamanho: 12 });
  escrever(ctx, `CNPJ ${formatarCnpj(empresa.cnpj)}`, { tamanho: 10, cor: TINTA_SUAVE });
  const complemento = [
    empresa.anexoSimples ? `Anexo ${empresa.anexoSimples}` : null,
    empresa.uf ?? null,
    `Ciclo ${resultado.cicloDecisao}`,
  ]
    .filter(Boolean)
    .join(' · ');
  escrever(ctx, complemento, { tamanho: 10, cor: TINTA_SUAVE, espacoDepois: 14 });

  // --- Recomendacao em destaque ---
  escrever(ctx, resumo.titulo, { tamanho: 15, fonte: negrito, cor: DESTAQUE, espacoDepois: 4 });
  escrever(ctx, `Grau de confianca da simulacao: ${resultado.confianca.toUpperCase()}`, {
    tamanho: 9.5,
    cor: resultado.confianca === 'alta' ? TINTA_SUAVE : ALERTA,
    espacoDepois: 14,
  });

  // --- Explicacao em linguagem simples ---
  for (const paragrafo of resumo.paragrafos) {
    escrever(ctx, paragrafo, { tamanho: 10, espacoDepois: 9 });
  }

  ctx.y -= 6;

  // --- Tabela comparativa ---
  escrever(ctx, 'Comparativo por ano da transicao', {
    tamanho: 12,
    fonte: negrito,
    espacoDepois: 8,
  });
  tabelaProjecao(ctx, resultado);

  // --- Observacoes / premissas ---
  escrever(ctx, 'Premissas e limitacoes', { tamanho: 12, fonte: negrito, espacoDepois: 6 });
  for (const observacao of resultado.observacoes) {
    escrever(ctx, `• ${observacao}`, { tamanho: 9, cor: TINTA_SUAVE, espacoDepois: 4 });
  }

  ctx.y -= 10;

  // --- Data-base e responsabilidade tecnica (secao 8) ---
  regua(ctx);
  escrever(
    ctx,
    `Data-base da simulacao: ${new Date(resultado.calculadoEm).toLocaleString('pt-BR', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'America/Sao_Paulo',
    })}`,
    { tamanho: 9, cor: TINTA_SUAVE },
  );
  escrever(ctx, `Versao do motor de calculo: ${resultado.versaoMotor}`, {
    tamanho: 9,
    cor: TINTA_SUAVE,
    espacoDepois: 10,
  });
  caixa(ctx, AVISO_RESPONSABILIDADE, TINTA, FUNDO_CABECALHO);

  // --- Anexo: memoria de calculo ---
  memoriaDeCalculo(ctx, resultado);

  // --- Rodape em todas as paginas ---
  const paginas = pdf.getPages();
  paginas.forEach((pagina, i) => {
    pagina.drawText(
      `Copiloto da Reforma · ${formatarCnpj(empresa.cnpj)} · pagina ${i + 1} de ${paginas.length}`,
      { x: MARGEM, y: MARGEM - 24, size: 8, font: regular, color: TINTA_SUAVE },
    );
  });

  pdf.setTitle(`Laudo de simulacao — ${empresa.razaoSocial}`);
  pdf.setSubject('Simulacao dentro/fora do DAS — Reforma Tributaria');
  pdf.setProducer('Copiloto da Reforma');
  pdf.setCreationDate(new Date(resultado.calculadoEm));

  return Buffer.from(await pdf.save());
}

export { montarResumo, AVISO_RESPONSABILIDADE, TARJA_PROVISORIA };
