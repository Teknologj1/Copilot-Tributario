-- Copiloto da Reforma — schema do piloto (secao 4 da especificacao).
--
-- Este arquivo e a visao consolidada do schema. A fonte da verdade para
-- aplicar mudancas em um banco existente sao os arquivos de db/migrations/.
-- Ao alterar o schema: crie uma migration nova E atualize este arquivo.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Escritorio de contabilidade (o cliente B2B2B)
CREATE TABLE escritorios (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome            TEXT NOT NULL,
  cnpj            TEXT NOT NULL UNIQUE,
  whatsapp_numero TEXT NOT NULL,
  plano           TEXT NOT NULL DEFAULT 'piloto', -- piloto | acompanhamento
  -- Autenticacao do piloto (secao 7): uma API key por escritorio, guardada
  -- apenas como hash — a chave em claro so existe no momento da emissao.
  api_key_hash    TEXT,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT escritorios_plano_valido CHECK (plano IN ('piloto', 'acompanhamento'))
);

CREATE UNIQUE INDEX escritorios_whatsapp_numero_idx ON escritorios (whatsapp_numero);
CREATE UNIQUE INDEX escritorios_api_key_hash_idx ON escritorios (api_key_hash) WHERE api_key_hash IS NOT NULL;

-- Empresa-cliente do escritorio (o CNPJ que sera simulado)
CREATE TABLE empresas_cliente (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escritorio_id   UUID NOT NULL REFERENCES escritorios(id),
  razao_social    TEXT NOT NULL,
  cnpj            TEXT NOT NULL,
  anexo_simples   TEXT,              -- Anexo I-V, quando conhecido
  uf              TEXT,
  status_decisao  TEXT NOT NULL DEFAULT 'pendente', -- pendente | simulado | decidido
  -- Prazo do ciclo de decisao vigente para esta empresa. A triagem (5.5)
  -- ordena por este campo: "ordenadas por proximidade do prazo".
  prazo_decisao   DATE,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (escritorio_id, cnpj),
  CONSTRAINT empresas_status_valido CHECK (status_decisao IN ('pendente', 'simulado', 'decidido'))
);

CREATE INDEX empresas_triagem_idx ON empresas_cliente (escritorio_id, status_decisao, prazo_decisao);

-- Cada rodada de simulacao (historico — uma empresa pode ser simulada varias vezes)
CREATE TABLE simulacoes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id        UUID NOT NULL REFERENCES empresas_cliente(id),
  ciclo             TEXT NOT NULL,      -- ex: '2026-09'
  -- dados_entrada e resultado carregam dados fiscais de terceiros e sao
  -- gravados CIFRADOS (AES-256-GCM, ver src/seguranca/cripto.ts e secao 8).
  -- O envelope cifrado e um JSONB {v, alg, iv, tag, ct} — nunca o dado em claro.
  dados_entrada     JSONB NOT NULL,
  resultado         JSONB NOT NULL,
  recomendacao      TEXT NOT NULL,      -- 'dentro_das' | 'fora_das'
  confianca         TEXT NOT NULL DEFAULT 'baixa', -- alta | media | baixa
  -- Versao do motor/parametros que produziu este resultado. Sem isso nao da
  -- para saber, depois, se um laudo antigo saiu de regras ja corrigidas.
  motor_versao      TEXT NOT NULL DEFAULT 'nao-validado',
  laudo_pdf_url     TEXT,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT simulacoes_recomendacao_valida CHECK (recomendacao IN ('dentro_das', 'fora_das')),
  CONSTRAINT simulacoes_confianca_valida CHECK (confianca IN ('alta', 'media', 'baixa'))
);

CREATE INDEX simulacoes_empresa_idx ON simulacoes (empresa_id, criado_em DESC);

-- Log de mensagens recebidas via WhatsApp (auditoria + reprocessamento)
CREATE TABLE mensagens_recebidas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escritorio_id   UUID NOT NULL REFERENCES escritorios(id),
  tipo_anexo      TEXT,               -- 'xml_nfe' | 'pgdas' | 'sped' | 'texto'
  conteudo_bruto  TEXT,               -- referencia ao arquivo no armazenamento, ou o texto da mensagem
  status          TEXT NOT NULL DEFAULT 'recebida', -- recebida | processando | processada | erro
  erro_detalhe    TEXT,
  -- Id da mensagem no DisparaIA: torna o webhook idempotente (a mesma
  -- mensagem reentregue nao dispara duas simulacoes nem duas cobrancas).
  origem_mensagem_id TEXT,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT mensagens_status_valido CHECK (status IN ('recebida', 'processando', 'processada', 'erro')),
  CONSTRAINT mensagens_tipo_valido CHECK (tipo_anexo IS NULL OR tipo_anexo IN ('xml_nfe', 'pgdas', 'sped', 'texto'))
);

CREATE UNIQUE INDEX mensagens_origem_idx ON mensagens_recebidas (escritorio_id, origem_mensagem_id)
  WHERE origem_mensagem_id IS NOT NULL;
CREATE INDEX mensagens_status_idx ON mensagens_recebidas (status, criado_em);

-- Estado da conversa no WhatsApp (5.3 — state machine do fluxo guiado).
CREATE TABLE conversas (
  escritorio_id   UUID PRIMARY KEY REFERENCES escritorios(id),
  estado          TEXT NOT NULL DEFAULT 'ocioso',
  contexto        JSONB NOT NULL DEFAULT '{}'::jsonb,
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Log de auditoria (secao 8): quem simulou o que e quando.
-- Append-only: o trigger abaixo recusa UPDATE e DELETE, para que o log nao
-- seja apagavel por engano pela propria aplicacao.
CREATE TABLE auditoria (
  id              BIGSERIAL PRIMARY KEY,
  escritorio_id   UUID REFERENCES escritorios(id),
  ator            TEXT NOT NULL,       -- numero de WhatsApp, api key id, ou 'sistema'
  acao            TEXT NOT NULL,       -- ex: 'simulacao.criada', 'laudo.baixado'
  entidade        TEXT,                -- ex: 'simulacoes'
  entidade_id     TEXT,
  detalhe         JSONB NOT NULL DEFAULT '{}'::jsonb,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX auditoria_escritorio_idx ON auditoria (escritorio_id, criado_em DESC);

CREATE OR REPLACE FUNCTION auditoria_imutavel() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'auditoria e append-only: % nao e permitido', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER auditoria_sem_update BEFORE UPDATE OR DELETE ON auditoria
  FOR EACH ROW EXECUTE FUNCTION auditoria_imutavel();
