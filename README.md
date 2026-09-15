# Copiloto da Reforma — piloto

Ferramenta de apoio à decisão para escritórios de contabilidade: o contador manda os
XMLs de NF-e de um cliente pelo WhatsApp e recebe de volta uma simulação de **"dentro
vs. fora do DAS"** projetada ao longo da transição da reforma tributária, em linguagem
simples, com laudo em PDF anexo.

Implementa as Fases 0–1 do roadmap (seções 1 a 10 da especificação técnica).

> ### ⚠️ Antes de qualquer uso real
>
> **O motor de cálculo ainda não foi validado por contador ou tributarista.** Enquanto
> `MOTOR_VALIDADO=false`, toda simulação sai marcada como provisória, com confiança
> `baixa`, e simular em produção retorna **503**.
>
> O roteiro dessa validação está em [`docs/VALIDACAO-FISCAL.md`](docs/VALIDACAO-FISCAL.md).
> Todo o resto do piloto funciona e não depende dela.

---

## Como rodar

### Sem infraestrutura nenhuma

Para ver o fluxo inteiro funcionando — parse do XML, simulação e laudo em PDF — sem
banco, sem Redis e sem WhatsApp:

```bash
npm install
npm run exemplo                    # gera ./exemplo-laudo.pdf
npm run exemplo -- caminho/para/suas-notas.xml
ANEXO=III FOLHA=300000 npm run exemplo
```

### Testes

```bash
npm test          # 118 testes, incluindo o ponta a ponta XML -> laudo
npm run typecheck
```

### Piloto completo

```bash
cp .env.example .env               # preencha DATABASE_URL e CHAVE_CRIPTOGRAFIA
npm run migrate                    # cria o schema
npm run seed -- "Contabilidade Modelo" 12345678000195 +5511999990000
npm run dev                        # API em :3000
npm run worker                     # só necessário quando há REDIS_URL
```

Sem `REDIS_URL` a fila roda **inline**, no mesmo processo: bom para desenvolvimento,
recusado em produção pelas checagens de boot.

---

## Como funciona

```
WhatsApp ──▶ webhook ──▶ intake ──▶ fila ──▶ parser ──▶ motor ──▶ laudo ──▶ WhatsApp
                           │                                         │
                           └────────── banco (cifrado) ◀─────────────┘
```

O pipeline é linear e o monólito é dividido por módulo — não há microserviço aqui.

| Pasta | Papel | Seção |
|---|---|---|
| `src/intake/` | Handler do WhatsApp e máquina de estados da conversa | 5.3 |
| `src/parser/` | Extração de dados fiscais do XML de NF-e | 5.1 |
| `src/simulacao/` | Motor dentro/fora do DAS e tabela de parâmetros | 5.2 e 6 |
| `src/laudo/` | Geração do PDF e do texto em linguagem simples | 5.4 |
| `src/triagem/` | Lista de CNPJs pendentes de decisão | 5.5 |
| `src/fila/` | BullMQ (ou inline), pipeline e retenção | 3 e 8 |
| `src/api/` | Endpoints HTTP e autenticação | 7 |
| `src/db/` | Schema, migrations e repositórios | 4 |
| `src/seguranca/` | Criptografia em repouso e API keys | 8 |

### Conversa no WhatsApp

O fluxo é guiado por estados, sem interpretação livre de linguagem natural — mais
previsível e mais fácil de auditar quando o contador disser "o sistema entendeu errado".

| Comando | O que faz |
|---|---|
| *(anexar XML)* | Lê as notas e inicia a simulação |
| `simular [CNPJ]` | Simula uma empresa já cadastrada |
| `pendentes` | Triagem: quem ainda não tem decisão |
| `cancelar` | Abandona o atendimento atual |
| `pular` | Dispensa um campo opcional |

O que o XML não informa, o sistema pergunta — um campo por vez, e só avança quando
entendeu a resposta. O Anexo do Simples é obrigatório; folha e compras são opcionais
(e reduzem a confiança do resultado quando faltam). A folha só é perguntada nos Anexos
III e V, onde o Fator R decide o enquadramento.

### API

```
POST   /webhook/whatsapp                       # entrada do DisparaIA (HMAC + idempotente)
POST   /api/simulacoes                         # simulação sob demanda
GET    /api/simulacoes/:id                     # resultado
GET    /api/escritorios/:id/empresas?status=   # triagem
GET    /api/simulacoes/:id/laudo.pdf           # download do laudo
GET    /saude
```

Autenticação por API key de escritório: `Authorization: Bearer cr_...`. Uma chave só
enxerga o próprio escritório.

---

## Decisões que valem saber

**Nenhuma alíquota está escrita em código.** Todos os números fiscais vivem em
`src/simulacao/parametros/transicao.json`, cada um com `_status` e `_fonte`. A revisão
do contador acontece nesse arquivo e em três funções de `motor.ts` — não no sistema
inteiro. Isso é o que permitiu construir todo o resto sem esperar a validação fiscal.

**Toda simulação carrega memória de cálculo** — rubrica, valor e a fórmula que produziu
o valor, linha a linha, na última página do laudo. Contador não assina caixa-preta.

**A recomendação olha o período inteiro, não o primeiro ano.** A transição inverte o
jogo no meio do caminho em vários perfis; otimizar 2026 isolado leva à decisão errada
para 2033. Quando há inversão, o laudo diz em que ano ela acontece.

**A composição B2B/B2C é ponderada por valor**, não por contagem de notas — uma venda
de R$ 50 mil para uma indústria e cem vendas de R$ 50 no balcão não pesam igual.

**Dados fiscais de terceiros são cifrados em repouso** (AES-256-GCM) antes de tocar o
banco, e a trilha de auditoria é *append-only* por trigger: nem a aplicação consegue
apagar. Ver seção 8 e `src/seguranca/cripto.ts`.

**Escopo do piloto:** só XML de NF-e. PGDAS e SPED são stubs que respondem com um aviso
claro de Fase 2 — decisão da própria seção 5.1, para não travar o cronograma tentando
ler PDF.

---

## Estado em relação aos critérios de aceite (seção 10)

| Critério | Estado |
|---|---|
| XML → simulação em menos de 2 minutos | ✅ pipeline assíncrono; o e2e roda em ~400ms |
| Laudo em PDF anexado na conversa | ✅ coberto por teste; falta plugar as credenciais reais do DisparaIA |
| Triagem retorna a lista correta | ✅ |
| Proteções mínimas da seção 8 | ✅ criptografia, retenção, auditoria imutável, aviso de responsabilidade |
| **Lógica de cálculo revisada por contador** | ❌ **pendente** — ver `docs/VALIDACAO-FISCAL.md` |
| 1 escritório piloto ponta a ponta com empresa real | ❌ depende do item acima |
