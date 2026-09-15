import fs from 'node:fs';
import path from 'node:path';
import { extrairDadosFiscais, anualizarFaturamento } from '../src/parser';
import { simular } from '../src/simulacao/motor';
import { gerarLaudo } from '../src/laudo';
import { montarResumo } from '../src/laudo/texto';

/**
 * Demonstracao ponta a ponta sem banco, sem Redis e sem WhatsApp:
 * XML de exemplo -> parse -> simulacao -> laudo em PDF no disco.
 *
 *   npm run exemplo
 *
 * Serve para o contador conferir o laudo e a memoria de calculo antes de
 * qualquer infraestrutura estar de pe.
 */

async function principal(): Promise<void> {
  const caminhoXml =
    process.argv[2] ?? path.join(__dirname, '..', 'tests', 'fixtures', 'nfe-lote.xml');

  console.log(`Lendo ${caminhoXml}\n`);

  const dados = await extrairDadosFiscais(fs.readFileSync(caminhoXml), 'xml_nfe');
  const faturamentoAnual = anualizarFaturamento(dados);

  console.log('--- Dados extraidos do XML ---');
  console.log(`Empresa .............. ${dados.razaoSocial ?? '(sem razao social)'}`);
  console.log(`CNPJ ................. ${dados.cnpj}`);
  console.log(`Notas de saida ....... ${dados.documentosProcessados}`);
  console.log(`Periodo .............. ${dados.periodos.join(', ')}`);
  console.log(`Faturamento .......... R$ ${dados.faturamentoBruto.toLocaleString('pt-BR')}`);
  console.log(`Anualizado ........... R$ ${faturamentoAnual.toLocaleString('pt-BR')}`);
  console.log(
    `Composicao ........... ${dados.composicaoReceita.percentualB2B}% B2B / ${dados.composicaoReceita.percentualB2C}% B2C`,
  );
  for (const aviso of dados.avisos) console.log(`  ! ${aviso}`);

  // O XML nao traz o anexo; no fluxo real o contador informa pelo chat.
  const anexoSimples = process.env.ANEXO ?? 'I';

  const resultado = await simular({
    cnpj: dados.cnpj,
    anexoSimples,
    faturamentoBrutoAnual: faturamentoAnual,
    composicaoReceita: dados.composicaoReceita,
    ano: new Date().getUTCFullYear(),
    comprasComCredito: process.env.COMPRAS ? Number(process.env.COMPRAS) : undefined,
    folhaSalarios12m: process.env.FOLHA ? Number(process.env.FOLHA) : undefined,
    uf: dados.uf,
  });

  console.log(`\n--- Simulacao (Anexo ${anexoSimples}) ---`);
  console.log(`Recomendacao ......... ${resultado.recomendacao}`);
  console.log(`Confianca ............ ${resultado.confianca}`);
  console.log(`Motor ................ ${resultado.versaoMotor}`);
  console.table(
    resultado.projecaoPorAno.map((a) => ({
      ano: a.ano,
      'dentro do DAS': a.cargaTributariaDentroDAS.toLocaleString('pt-BR'),
      'fora do DAS': a.cargaTributariaForaDAS.toLocaleString('pt-BR'),
      diferenca: a.diferenca.toLocaleString('pt-BR'),
    })),
  );

  console.log('--- Premissas ---');
  for (const obs of resultado.observacoes) console.log(`  • ${obs}`);

  const resumo = montarResumo(resultado, {
    razaoSocial: dados.razaoSocial ?? dados.cnpj,
    cnpj: dados.cnpj,
  });
  console.log(`\n--- Mensagem que iria para o WhatsApp ---\n${resumo.resumoWhatsapp}\n`);

  const pdf = await gerarLaudo(resultado, {
    razaoSocial: dados.razaoSocial ?? dados.cnpj,
    cnpj: dados.cnpj,
    anexoSimples,
    uf: dados.uf,
  });

  const saida = process.env.SAIDA ?? 'exemplo-laudo.pdf';
  fs.writeFileSync(saida, pdf);
  console.log(`Laudo gravado em ${saida} (${(pdf.length / 1024).toFixed(1)} KB)`);
}

principal().catch((erro) => {
  console.error('Falhou:', erro.message);
  process.exit(1);
});
