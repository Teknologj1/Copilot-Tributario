import { empresas, type EmpresaCliente } from '../db/repositorios';
import { formatarCnpj } from '../comum/cnpj';

/**
 * Triagem de portfolio — secao 5.5.
 *
 * Mesma consulta serve o endpoint JSON e o texto do WhatsApp; a formatacao e
 * que muda. Ordenacao por proximidade do prazo vem do repositorio.
 */

export interface ItemTriagem {
  empresaId: string;
  razaoSocial: string;
  cnpj: string;
  anexoSimples: string | null;
  uf: string | null;
  prazoDecisao: string | null;
  /** Dias restantes ate o prazo. Negativo = vencido. null = sem prazo definido. */
  diasRestantes: number | null;
}

function diasAte(prazo: Date | null, referencia: Date): number | null {
  if (!prazo) return null;
  const umDia = 86_400_000;
  const inicioPrazo = Date.UTC(
    prazo.getUTCFullYear(),
    prazo.getUTCMonth(),
    prazo.getUTCDate(),
  );
  const inicioHoje = Date.UTC(
    referencia.getUTCFullYear(),
    referencia.getUTCMonth(),
    referencia.getUTCDate(),
  );
  return Math.round((inicioPrazo - inicioHoje) / umDia);
}

export function paraItem(empresa: EmpresaCliente, referencia = new Date()): ItemTriagem {
  return {
    empresaId: empresa.id,
    razaoSocial: empresa.razao_social,
    cnpj: empresa.cnpj,
    anexoSimples: empresa.anexo_simples,
    uf: empresa.uf,
    prazoDecisao: empresa.prazo_decisao
      ? empresa.prazo_decisao.toISOString().slice(0, 10)
      : null,
    diasRestantes: diasAte(empresa.prazo_decisao, referencia),
  };
}

export async function listarPendentes(escritorioId: string): Promise<ItemTriagem[]> {
  const linhas = await empresas.pendentes(escritorioId);
  return linhas.map((e) => paraItem(e));
}

export async function listarPorStatus(
  escritorioId: string,
  status: 'pendente' | 'simulado' | 'decidido',
): Promise<ItemTriagem[]> {
  const linhas = await empresas.porStatus(escritorioId, status);
  return linhas.map((e) => paraItem(e));
}

function descreverPrazo(item: ItemTriagem): string {
  if (item.diasRestantes === null) return 'sem prazo definido';
  if (item.diasRestantes < 0) return `VENCIDO ha ${Math.abs(item.diasRestantes)} dia(s)`;
  if (item.diasRestantes === 0) return 'vence HOJE';
  if (item.diasRestantes === 1) return 'vence amanha';
  return `faltam ${item.diasRestantes} dias`;
}

/**
 * Texto formatado para o WhatsApp (5.5): "Voce tem 5 empresas pendentes: ...".
 * Lista longa e truncada — ninguem le 40 CNPJs numa mensagem de chat.
 */
export function formatarParaWhatsapp(itens: ItemTriagem[], limite = 10): string {
  if (itens.length === 0) {
    return 'Nenhuma empresa pendente de decisao neste ciclo. Carteira em dia.';
  }

  const cabecalho =
    itens.length === 1
      ? 'Voce tem *1 empresa* pendente de decisao:'
      : `Voce tem *${itens.length} empresas* pendentes de decisao:`;

  const linhas = itens.slice(0, limite).map((item, i) => {
    const anexo = item.anexoSimples ? ` · Anexo ${item.anexoSimples}` : '';
    return `${i + 1}. *${item.razaoSocial}*\n   ${formatarCnpj(item.cnpj)}${anexo}\n   ${descreverPrazo(item)}`;
  });

  const rodape =
    itens.length > limite
      ? `\n\n_...e mais ${itens.length - limite}. Consulte a lista completa pelo painel._`
      : '';

  return `${cabecalho}\n\n${linhas.join('\n\n')}${rodape}\n\nPara simular uma delas, envie: *simular [CNPJ]*`;
}
