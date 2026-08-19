-- 03_mensagens_whatsapp — conversa WhatsApp por lead (Fase 13, campanha de áudios).
--
-- Read-model rápido + durabilidade das mensagens: o que a UI da conversa lê (ms)
-- e o que sobrevive a restart do processo (o ring em memória do webhook não).
-- ClickUp Lista 03 segue sendo o REGISTRO operacional (task por envio + anexo);
-- esta tabela guarda a LINHA DO TEMPO da conversa dos dois lados.
--
-- id: id da mensagem na Evolution (recebidas via webhook) ou 'registro-<taskId>'
--     (envios nossos — casa com a convenção da rota de mídia).
-- telefone_canonico: dígitos sem o nono (régua telefoneCanonico do backend) —
--     chave de casamento lead↔mensagem quando lead_task_id ainda não é conhecido.
-- bruto: evento CRU do webhook (jsonb) — forense de formato sem depender do ring.

create table if not exists mensagens_whatsapp (
  id text primary key,
  lead_task_id text,
  telefone_canonico text not null default '',
  de_nos boolean not null default false,
  ts timestamptz not null,
  tipo text not null default 'outro', -- audio | texto | outro
  texto text,
  transcricao text,
  midia_base64 text,
  midia_mime text,
  bruto jsonb,
  criado_em timestamptz not null default now()
);

create index if not exists idx_mensagens_whatsapp_tel_ts
  on mensagens_whatsapp (telefone_canonico, ts);
create index if not exists idx_mensagens_whatsapp_lead_ts
  on mensagens_whatsapp (lead_task_id, ts);
