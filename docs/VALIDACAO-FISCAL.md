# Roteiro de validação fiscal

> Este documento existe por causa do item mais importante dos critérios de aceite
> (seção 10 da especificação):
>
> *"A lógica de cálculo da seção 6 foi revisada por um contador ou tributarista —
> não é aceitável rodar em produção sem essa validação."*

O sistema foi construído para que essa revisão seja **um trabalho delimitado**, e não
uma auditoria de código inteiro. Todo o resto do piloto — parser, laudo, conversa,
triagem, API — já funciona e não depende do resultado desta revisão.

---

## Como o sistema se protege enquanto a revisão não acontece

Enquanto `MOTOR_VALIDADO` não for `true`:

| Proteção | Onde |
|---|---|
| Toda simulação sai com `confianca: 'baixa'`, mesmo com dados completos | `src/simulacao/motor.ts` → `calcularConfianca()` |
| A primeira observação do resultado é "SIMULAÇÃO PROVISÓRIA" | `src/simulacao/motor.ts` → `simular()` |
| O laudo em PDF sai com tarja vermelha de simulação provisória | `src/laudo/index.ts` |
| A mensagem do WhatsApp avisa que a simulação é provisória | `src/fila/processadores.ts` |
| Simular com `NODE_ENV=producao` retorna **503** e não calcula nada | `ErroMotorNaoValidado` |

Essas travas são cobertas por testes (`tests/motor.test.ts` → "trava profissional").
Se alguém as remover sem querer, a suíte quebra.

---

## O que precisa ser revisado, em ordem de risco

Todos os números fiscais estão em **um único arquivo**:
`src/simulacao/parametros/transicao.json`. Não há alíquota escrita em código.
Cada bloco tem `_status` e `_fonte`.

### 1. `creditamento` — risco mais alto

É o coração da decisão para empresas com clientela B2B. Hoje está assim:

```json
"creditoTransferidoDentroDAS": 0.0,
"creditoTransferidoForaDAS": 1.0,
"impactoComercialB2B": { "fatorRepasse": 0.5 }
```

**O que conferir:**
- `creditoTransferidoDentroDAS = 0` assume que o cliente B2B **não aproveita nada**
  de crédito ao comprar de optante do Simples dentro do DAS. É conservador e quase
  certamente errado — a LC 214/2025 prevê aproveitamento limitado. **Este número
  sozinho pode inverter a recomendação de uma empresa.**
- `fatorRepasse = 0.5` é uma premissa **comercial**, não fiscal: quanto da perda de
  crédito do cliente volta como pressão de preço. Vale discutir com o escritório
  piloto, não só com o tributarista.

### 2. `transicaoIbsCbs` — calendário e alíquotas

Percentuais de CBS/IBS por ano e a fração de tributos antigos ainda devida
(`parcelaTributosAntigos`). Conferir contra a redação vigente da LC 214/2025 e a
Resolução CGSN nº 186/2026.

### 3. As fórmulas de `src/simulacao/motor.ts`

Três funções, e só elas:

| Função | O que faz |
|---|---|
| `aliquotaEfetivaSimples()` | `(RBT12 × nominal − dedução) / RBT12` |
| `calcularDentroDAS()` | DAS + custo comercial do crédito não transferido |
| `calcularForaDAS()` | IBS/CBS não cumulativo + IRPJ/CSLL + CPP + tributos antigos |

Simplificação conhecida a questionar: em `calcularForaDAS()`, os tributos antigos da
transição são estimados **proporcionalmente à carga de IBS/CBS**, e não calculados
sobre suas próprias bases. É uma aproximação assumida — está marcada na memória de
cálculo como "aproximação".

### 4. `regimeRegular` — proxy de Lucro Presumido

Presunções, IRPJ/CSLL e CPP patronal. O cenário "fora do DAS" é modelado como Lucro
Presumido, o que pode não ser o regime real de comparação de todo cliente.

### 5. `tabelasSimples` — Anexos I a V

Valores nominais da LC 123/2006. São públicos e estáveis, mas confira vigência e
eventuais alterações trazidas pela reforma.

---

## Como conferir um resultado na prática

Toda simulação carrega uma **memória de cálculo** linha a linha — rubrica, valor e a
fórmula que produziu o valor. Ela vai na última página do laudo em PDF e no campo
`resultado.memoriaCalculo` da API.

Para rodar um caso e ver a conta aberta:

```bash
npm run exemplo            # gera um laudo de exemplo em ./exemplo-laudo.pdf
```

---

## Liberando o motor após a revisão

Quando (e só quando) a revisão estiver concluída:

1. Corrija os valores em `src/simulacao/parametros/transicao.json`.
2. Preencha `revisadoPor` e `revisadoEm`, e troque cada `_status: "NAO_VALIDADO"`
   por `"validado"`.
3. Suba `versaoParametros` (ex.: `1.0.0`). Ela é carimbada em cada laudo e fica
   gravada em `simulacoes.motor_versao` — é o que permite saber, depois, se um laudo
   antigo saiu de regras já corrigidas.
4. Rode `npm test` — a suíte confere a estrutura dos parâmetros.
5. Só então, no ambiente:

```bash
MOTOR_VALIDADO=true
MOTOR_VALIDADO_POR="Nome do profissional — CRC/OAB nº ..."
```

**Não ligue essa flag para "testar em produção".** É exatamente ela que separa uma
ferramenta de apoio à decisão de um laudo tributário sem responsável técnico.
