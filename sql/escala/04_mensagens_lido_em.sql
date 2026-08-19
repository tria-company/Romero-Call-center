-- 04_mensagens_lido_em — estado de leitura da conversa (pedido 2026-08-19).
--
-- `lido_em` marca quando a mensagem do LEAD foi vista pelo operador (abrir a
-- conversa marca tudo dele como lido). A bolinha de notificação da lista acende
-- só para mensagem do lead ainda não lida — e o estado sobrevive a restart e
-- vale em qualquer aparelho (fica no banco, não no navegador).

alter table mensagens_whatsapp
  add column if not exists lido_em timestamptz;
