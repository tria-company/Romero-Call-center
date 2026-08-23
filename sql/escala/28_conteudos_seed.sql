-- escala/28_conteudos_seed.sql — SEED inicial da biblioteca de conteúdos (Fase 2).
-- Popula os conteúdos prontos que o Romero pediu (perfis, resgates, carroça,
-- kit multiplicador). Roda SÓ quando a tabela está vazia (guarda no DO abaixo) —
-- reaplicar NÃO duplica. O gestor edita/adiciona/exclui depois pela tela de gestão.
--
-- Fora do seed (sem URL definida ainda): "Panfleto digital" (fixado) e "Vídeo do
-- guia" (o Romero vai enviar) — adicionar pela tela quando o material existir.
--
-- Aplicar: node --env-file=.env scripts/aplicar-sql.mjs sql/escala/28_conteudos_seed.sql
-- REQUER sql/escala/27_conteudos.sql já aplicado.
-- LGPD: sem dado pessoal (os "contatos fixos" são números públicos da campanha).

do $$
begin
  if not exists (select 1 from conteudos) then
    insert into conteudos (categoria, titulo, tipo, texto, url, ordem) values
      ('Perfis', 'Instagram do Romero',  'link', null, 'https://www.instagram.com/romeroalbuquerque40000/', 1),
      ('Perfis', 'Instagram da Andreza', 'link', null, 'https://www.instagram.com/andrezaromero/', 2),
      ('Resgates', 'Resgate 1', 'link', null, 'https://www.instagram.com/p/DcRy56MPQU7/', 1),
      ('Resgates', 'Resgate 2', 'link', null, 'https://www.instagram.com/p/DcM7nzNA2-t/', 2),
      ('Resgates', 'Resgate 3', 'link', null, 'https://www.instagram.com/p/DcJ35BAAOz6/', 3),
      ('Resgates', 'Resgate 4', 'link', null, 'https://www.instagram.com/p/DcUmfqwgWro/', 4),
      ('Resgates', 'Resgate 5', 'link', null, 'https://www.instagram.com/p/DcJGJ2Vgu1S/', 5),
      ('Resgates', 'Resgate 6', 'link', null, 'https://www.instagram.com/p/DbyIxcVgDXl/', 6),
      ('Carroça', 'Carroça 1', 'link', null, 'https://www.instagram.com/p/DcUmfqwgWro/', 1),
      ('Carroça', 'Carroça 2', 'link', null, 'https://www.instagram.com/p/DcGRRAYP5o-/', 2),
      ('Carroça', 'Carroça 3', 'link', null, 'https://www.instagram.com/p/Db33bpTgJfI/', 3),
      ('Carroça', 'Carroça 4', 'link', null, 'https://www.instagram.com/p/Db6EnNSPFZL/', 4),
      ('Kit Multiplicador', 'Contatos fixos (Kit / Adesivo)', 'texto', '81995966340 / 995969040 / 995989940', null, 1);
  end if;
end $$;
