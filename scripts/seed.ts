import { escritorios, empresas } from '../src/db/repositorios';
import { gerarApiKey } from '../src/seguranca/cripto';
import { fecharPool } from '../src/db';
import { formatarCnpj } from '../src/comum/cnpj';

/**
 * Cadastra um escritorio piloto e emite a API key dele.
 *
 *   npm run seed -- "Escritorio Contabil X" 12345678000195 +5511999990000
 *
 * A chave em claro aparece UMA VEZ, aqui. Depois so o hash fica no banco.
 */

async function principal(): Promise<void> {
  const [nome, cnpj, whatsapp] = process.argv.slice(2);

  if (!nome || !cnpj || !whatsapp) {
    console.error(
      'Uso: npm run seed -- "<nome>" <cnpj> <whatsapp>\n' +
        'Ex.:  npm run seed -- "Contabilidade Modelo" 12345678000195 +5511999990000',
    );
    process.exit(1);
  }

  const { chave, hash } = gerarApiKey();

  const escritorio = await escritorios.criar({
    nome,
    cnpj,
    whatsappNumero: whatsapp,
    apiKeyHash: hash,
  });

  console.log('\nEscritorio cadastrado:');
  console.log(`  id ......... ${escritorio.id}`);
  console.log(`  nome ....... ${escritorio.nome}`);
  console.log(`  cnpj ....... ${formatarCnpj(escritorio.cnpj)}`);
  console.log(`  whatsapp ... ${escritorio.whatsapp_numero}`);
  console.log('\n  API KEY (guarde agora — nao da para recuperar depois):');
  console.log(`  ${chave}\n`);

  // Empresa-cliente de exemplo, para a triagem ter o que listar.
  if (process.env.COM_EXEMPLO === '1') {
    const empresa = await empresas.garantir({
      escritorioId: escritorio.id,
      cnpj: '98765432000198',
      razaoSocial: 'EMPRESA EXEMPLO LTDA',
      anexoSimples: 'I',
      uf: 'SP',
      prazoDecisao: new Date('2026-11-30'),
    });
    console.log(`  Empresa de exemplo criada: ${empresa.razao_social} (${empresa.id})\n`);
  }

  await fecharPool();
}

principal().catch(async (erro) => {
  console.error('Falhou:', erro.message);
  await fecharPool().catch(() => undefined);
  process.exit(1);
});
