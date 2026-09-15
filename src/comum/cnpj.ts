/** Normalizacao e validacao de CNPJ — usado no intake, no parser e na API. */

export function normalizarCnpj(entrada: string): string {
  return (entrada ?? '').replace(/\D/g, '');
}

export function formatarCnpj(cnpj: string): string {
  const d = normalizarCnpj(cnpj);
  if (d.length !== 14) return cnpj;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

/** Valida os dois digitos verificadores (modulo 11). */
export function cnpjValido(entrada: string): boolean {
  const d = normalizarCnpj(entrada);
  if (d.length !== 14) return false;
  // Sequencias repetidas (00000000000000 etc.) passam no modulo 11 mas nao existem.
  if (/^(\d)\1{13}$/.test(d)) return false;

  const digito = (base: string, pesos: number[]): number => {
    const soma = base
      .split('')
      .reduce((acc, ch, i) => acc + Number(ch) * (pesos[i] as number), 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  const dv1 = digito(d.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const dv2 = digito(d.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);

  return dv1 === Number(d[12]) && dv2 === Number(d[13]);
}
