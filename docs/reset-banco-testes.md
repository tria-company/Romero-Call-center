# Como apagar os testes do agente (reset do banco)

Status: approved — 2026-05-08

Guia passo a passo para limpar os dados de teste do agente Sofia no Supabase. Use quando precisar comecar uma nova bateria de testes do zero.

> **AVISO:** `TRUNCATE` e irreversivel. So execute em ambiente de teste, ou depois de confirmar que nao ha dados de producao na base. Se houver duvida, faca um backup antes (Database → Backups no Studio).

## Tabelas envolvidas

Schema atual ([docs/sql/01_init.sql](sql/01_init.sql)) — todas com sufixo `_roberth`:

| Tabela | O que guarda | FK |
|---|---|---|
| `customers_roberth` | Clientes (telefone, nome, email) | — |
| `conversations_roberth` | Conversas abertas/encerradas, status, agente atual | `customer_id` → customers |
| `messages_roberth` | Cada mensagem trocada (user/assistant/tool) | `conversation_id` → conversations |
| `objecoes_roberth` | Objecoes detectadas pela tool de objecao | `conversation_id` + `customer_id` |

Todas as FKs tem `ON DELETE CASCADE`, entao apagar um cliente apaga em cascata as conversas, mensagens e objecoes dele.

## Onde executar

1. Acesse o SQL Editor do projeto:
   <https://supabase.com/dashboard/project/<project-id>/sql/new>
2. Cole **uma** das opcoes abaixo (nao as duas).
3. Clique em **Run**.

## Opcao 1 — Apagar telefones especificos (RECOMENDADO)

Modo mais seguro. Voce informa um ou mais telefones e o `ON DELETE CASCADE` apaga, em cascata, as conversas, mensagens e objecoes ligadas a esses clientes — o resto da base fica intacto.

**Importante:** o telefone tem que estar no **mesmo formato** que foi gravado em `customers_roberth.telefone` (geralmente `+55DDDNUMERO`, sem espacos nem parenteses). Confira primeiro com:

```sql
SELECT id, telefone, nome, created_at
FROM customers_roberth
ORDER BY created_at DESC
LIMIT 20;
```

### 1a. Um unico numero

Substitua `+55XXXXXXXXXXX` pelo telefone alvo:

```sql
DELETE FROM customers_roberth
WHERE telefone = '+55XXXXXXXXXXX';
```

### 1b. Varios numeros de uma vez

```sql
DELETE FROM customers_roberth
WHERE telefone IN (
  '+55XXXXXXXXXXX',
  '+55YYYYYYYYYYY',
  '+55ZZZZZZZZZZZ'
);
```

### 1c. So zerar o historico de conversa, mantendo o cliente cadastrado

Quando voce quer preservar o registro do cliente em `customers_roberth` (nome/email) mas apagar todas as conversas e mensagens dele:

```sql
DELETE FROM conversations_roberth
WHERE customer_id IN (
  SELECT id FROM customers_roberth
  WHERE telefone IN (
    '+55XXXXXXXXXXX',
    '+55YYYYYYYYYYY'
  )
);
```

A delecao das conversas faz cascata em `messages_roberth` e `objecoes_roberth`.

## Opcao 2 — Apagar so as ultimas X horas

Util pra apagar so a sessao de teste recente sem mexer em telefone especifico. Ajuste o intervalo:

```sql
-- intervalo: '1 hour', '2 hours', '24 hours', '1 day', etc.
DELETE FROM messages_roberth
WHERE created_at > now() - interval '24 hours';

DELETE FROM objecoes_roberth
WHERE created_at > now() - interval '24 hours';

DELETE FROM conversations_roberth
WHERE data_ultima_mensagem > now() - interval '24 hours';
```

## Opcao 3 — Reset parcial (preserva clientes)

Apaga mensagens, conversas e objecoes, mas mantem a tabela de clientes intacta. Use quando ja tem contatos reais cadastrados e quer apenas zerar todo o historico de conversa de uma vez.

```sql
TRUNCATE TABLE
  messages_roberth,
  objecoes_roberth,
  conversations_roberth
RESTART IDENTITY;
```

## Opcao 4 — Reset total (apaga ate clientes)

Zera **todas** as 4 tabelas. So use em ambiente puramente de teste.

```sql
TRUNCATE TABLE
  customers_roberth,
  conversations_roberth,
  messages_roberth,
  objecoes_roberth
RESTART IDENTITY CASCADE;
```

`CASCADE` e necessario porque `customers_roberth` e referenciada pelas demais tabelas.

## Validacao pos-reset

Para Opcao 3 ou 4 (reset geral) — confirmar contagens:

```sql
SELECT
  (SELECT count(*) FROM customers_roberth)     AS customers,
  (SELECT count(*) FROM conversations_roberth) AS conversations,
  (SELECT count(*) FROM messages_roberth)      AS messages,
  (SELECT count(*) FROM objecoes_roberth)      AS objecoes;
```

Esperado apos Opcao 4: tudo `0`. Apos Opcao 3: so `customers` deve ter valor `> 0`.

Para Opcao 1 (telefones especificos) — confirmar que sumiram:

```sql
SELECT count(*) FROM customers_roberth
WHERE telefone IN ('+55XXXXXXXXXXX', '+55YYYYYYYYYYY');
-- esperado: 0
```

## Checklist antes de rodar

- [ ] Confirmei que estou no projeto certo (`<project-id>`).
- [ ] Confirmei que nao ha dados de producao/lancamento real nessa base.
- [ ] Escolhi **uma** opcao (nao executei mais de uma sem necessidade).
- [ ] Se for ambiente compartilhado, avisei o time antes.
