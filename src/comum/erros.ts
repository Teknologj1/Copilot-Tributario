/** Erros de dominio — carregam o status HTTP e uma mensagem segura ao usuario. */

export class ErroDominio extends Error {
  constructor(
    message: string,
    readonly codigo: string,
    readonly status: number = 400,
    readonly detalhes?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ErroValidacao extends ErroDominio {
  constructor(message: string, detalhes?: Record<string, unknown>) {
    super(message, 'validacao', 400, detalhes);
  }
}

export class ErroNaoEncontrado extends ErroDominio {
  constructor(recurso: string) {
    super(`${recurso} nao encontrado`, 'nao_encontrado', 404);
  }
}

export class ErroNaoAutorizado extends ErroDominio {
  constructor(message = 'Credencial ausente ou invalida') {
    super(message, 'nao_autorizado', 401);
  }
}

export class ErroParser extends ErroDominio {
  constructor(message: string, detalhes?: Record<string, unknown>) {
    super(message, 'parser', 422, detalhes);
  }
}

/**
 * Bloqueio da secao 6: o motor de calculo nao pode rodar em producao sem
 * validacao de um contador/tributarista.
 */
export class ErroMotorNaoValidado extends ErroDominio {
  constructor() {
    super(
      'O motor de simulacao nao foi validado por contador/tributarista e por ' +
        'isso esta bloqueado em producao (secao 6 e criterio de aceite da secao 10). ' +
        'Defina MOTOR_VALIDADO=true somente apos a revisao tecnica formal.',
      'motor_nao_validado',
      503,
    );
  }
}
