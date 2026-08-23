-- escala/30_conteudos_panfletos.sql — cadastra os PANFLETOS digitais na biblioteca
-- (Fase 5). As imagens já estão hospedadas no bucket PÚBLICO 'conteudos' do
-- Supabase self-hosted (subidas por scripts/upload-conteudo-midia.mjs, verificadas
-- HTTP 200). tipo=imagem -> enviadas NATIVAMENTE via Evolution /sendMedia.
--
-- Idempotente (INSERT ... WHERE NOT EXISTS por categoria+titulo) — reaplicar não
-- duplica. REQUER escala/27_conteudos.sql já aplicado. LGPD: material público de campanha.

insert into conteudos (categoria, titulo, tipo, texto, url, ordem)
select 'Panfleto digital', 'Panfleto — Hospital 24h e conquistas', 'imagem', null,
       'https://supabase.gabinetedoromero.com.br/storage/v1/object/public/conteudos/panfletos/panfleto-digital-1.png', 1
where not exists (select 1 from conteudos where categoria = 'Panfleto digital' and titulo = 'Panfleto — Hospital 24h e conquistas');

insert into conteudos (categoria, titulo, tipo, texto, url, ordem)
select 'Panfleto digital', 'Panfleto — A vida dos animais mudou', 'imagem', null,
       'https://supabase.gabinetedoromero.com.br/storage/v1/object/public/conteudos/panfletos/panfletodigital.png', 2
where not exists (select 1 from conteudos where categoria = 'Panfleto digital' and titulo = 'Panfleto — A vida dos animais mudou');

insert into conteudos (categoria, titulo, tipo, texto, url, ordem)
select 'Panfleto digital', 'Panfleto — Fim das carroças', 'imagem', null,
       'https://supabase.gabinetedoromero.com.br/storage/v1/object/public/conteudos/panfletos/panfletodigital.jpg.jpeg', 3
where not exists (select 1 from conteudos where categoria = 'Panfleto digital' and titulo = 'Panfleto — Fim das carroças');
