"use client";

import * as React from "react";
import { Check, Pencil, Plus, Trash2 } from "lucide-react";
import { atualizarConteudo, criarConteudo, excluirConteudo, listarConteudos } from "@/lib/conteudos-real";
import type { ConteudoReal, ConteudoTipo } from "@/lib/conteudos-real";

/* ══════════════════════════════════════════════════════════════════════════
   BibliotecaConteudos — GESTÃO dos conteúdos (Fase 2). Redesenho 2026-08-23:
   deixou de ser tela cheia; agora é CONTEÚDO EMBUTIDO na aba "Gerenciar" do
   painel deslizante da conversa (o frame/fechar/abas ficam no Audios). Adiciona,
   edita, exclui (soft-delete) e categoriza. `onChange` avisa o pai pra atualizar
   a aba "Enviar". LGPD: sem dado pessoal.
   ══════════════════════════════════════════════════════════════════════════ */

export function BibliotecaConteudos({ onChange }: { onChange?: () => void }) {
  const [itens, setItens] = React.useState<ConteudoReal[]>([]);
  const [carregando, setCarregando] = React.useState(true);
  const [salvando, setSalvando] = React.useState(false);
  const [editando, setEditando] = React.useState<ConteudoReal | null>(null);
  const [confirmandoExcluir, setConfirmandoExcluir] = React.useState<string | null>(null);

  // form
  const [categoria, setCategoria] = React.useState("");
  const [titulo, setTitulo] = React.useState("");
  const [tipo, setTipo] = React.useState<ConteudoTipo>("link");
  const [texto, setTexto] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [erro, setErro] = React.useState("");

  const recarregar = React.useCallback(async () => {
    setCarregando(true);
    setItens(await listarConteudos());
    setCarregando(false);
  }, []);

  React.useEffect(() => {
    void recarregar();
  }, [recarregar]);

  function limparForm() {
    setEditando(null);
    setCategoria("");
    setTitulo("");
    setTipo("link");
    setTexto("");
    setUrl("");
    setErro("");
  }

  function carregarNoForm(c: ConteudoReal) {
    setEditando(c);
    setCategoria(c.categoria ?? "");
    setTitulo(c.titulo);
    setTipo(c.tipo);
    setTexto(c.texto ?? "");
    setUrl(c.url ?? "");
    setErro("");
  }

  async function salvar() {
    const t = titulo.trim();
    if (!t) return setErro("Título é obrigatório.");
    if (tipo === "texto" && !texto.trim()) return setErro("Texto é obrigatório.");
    if (tipo !== "texto" && !url.trim()) return setErro(tipo === "link" ? "URL é obrigatória." : "URL da mídia é obrigatória.");
    setSalvando(true);
    setErro("");
    const dados = {
      categoria: categoria.trim() || null,
      titulo: t,
      tipo,
      texto: tipo === "texto" ? texto : null,
      url: tipo === "texto" ? null : url.trim(),
    };
    const r = editando ? await atualizarConteudo(editando.id, dados) : await criarConteudo(dados);
    setSalvando(false);
    if (!r) return setErro("Não deu para salvar. Tente de novo.");
    limparForm();
    await recarregar();
    onChange?.();
  }

  async function remover(id: string) {
    const ok = await excluirConteudo(id);
    setConfirmandoExcluir(null);
    if (ok) {
      if (editando?.id === id) limparForm();
      await recarregar();
      onChange?.();
    }
  }

  return (
    <div className="bc-panel">
      <style>{BC_CSS}</style>

      {/* formulário de adicionar/editar */}
      <div className="bc-form">
        <div className="bc-formtit">{editando ? "Editar conteúdo" : "Novo conteúdo"}</div>
        <div className="bc-row">
          <input className="bc-in" placeholder="Categoria (ex.: Resgates)" value={categoria} onChange={(e) => setCategoria(e.target.value)} maxLength={60} />
          <select className="bc-in bc-sel" value={tipo} onChange={(e) => setTipo(e.target.value as ConteudoTipo)} aria-label="Tipo do conteúdo">
            <option value="link">Link</option>
            <option value="texto">Texto</option>
            <option value="imagem">Imagem</option>
            <option value="video">Vídeo</option>
            <option value="audio">Áudio</option>
          </select>
        </div>
        <input className="bc-in" placeholder="Título (ex.: Instagram do Romero)" value={titulo} onChange={(e) => setTitulo(e.target.value)} maxLength={120} />
        {tipo === "texto" ? (
          <textarea className="bc-ta" placeholder="Texto da mensagem" value={texto} onChange={(e) => setTexto(e.target.value)} rows={3} maxLength={4096} />
        ) : (
          <input
            className="bc-in"
            placeholder={tipo === "link" ? "URL (https://…)" : "URL da mídia (https://…)"}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            inputMode="url"
            maxLength={2000}
          />
        )}
        {erro && <div className="bc-erro">{erro}</div>}
        <div className="bc-acts">
          {editando && (
            <button type="button" className="bc-btn ghost" onClick={limparForm} disabled={salvando}>
              Cancelar
            </button>
          )}
          <button type="button" className="bc-btn go" onClick={() => void salvar()} disabled={salvando}>
            {salvando ? "Salvando…" : editando ? (<><Check size={15} /> Salvar</>) : (<><Plus size={15} /> Adicionar</>)}
          </button>
        </div>
      </div>

      {/* lista */}
      <div className="bc-list">
        {carregando ? (
          <div className="bc-vazio">Carregando…</div>
        ) : itens.length === 0 ? (
          <div className="bc-vazio">Nenhum conteúdo ainda. Adicione o primeiro acima.</div>
        ) : (
          itens.map((c) => (
            <div key={c.id} className="bc-item">
              <div className="bc-itxt">
                <div className="bc-ihead">
                  <span className="bc-itag">{c.tipo}</span>
                  {c.categoria && <span className="bc-icat">{c.categoria}</span>}
                </div>
                <div className="bc-inome">{c.titulo}</div>
                <div className="bc-isub">{c.tipo === "texto" ? (c.texto ?? "") : (c.url ?? "")}</div>
              </div>
              <div className="bc-iacts">
                <button type="button" className="bc-ib" onClick={() => carregarNoForm(c)} aria-label="Editar">
                  <Pencil size={16} />
                </button>
                {confirmandoExcluir === c.id ? (
                  <button type="button" className="bc-ib danger" onClick={() => void remover(c.id)} aria-label="Confirmar exclusão">
                    <Check size={16} />
                  </button>
                ) : (
                  <button type="button" className="bc-ib" onClick={() => setConfirmandoExcluir(c.id)} aria-label="Excluir">
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const BC_CSS = `
.bc-panel{ display:flex; flex-direction:column; gap:14px; }
.bc-form{ display:flex; flex-direction:column; gap:9px; border:1px solid var(--line); border-radius:14px; padding:13px; background:var(--bg-0); }
.bc-formtit{ font-size:13px; font-weight:800; color:var(--ink); }
.bc-row{ display:flex; gap:9px; flex-wrap:wrap; }
.bc-in{ flex:1; min-width:120px; height:44px; padding:0 12px; border:1px solid var(--line); border-radius:10px; background:var(--bg-1); color:var(--ink); font-size:15px; outline:none; }
.bc-ta{ width:100%; padding:11px 12px; border:1px solid var(--line); border-radius:10px; background:var(--bg-1); color:var(--ink); font-size:15px; outline:none; resize:vertical; font-family:inherit; }
.bc-in::placeholder,.bc-ta::placeholder{ color:var(--dim); }
.bc-sel{ flex:none; min-width:120px; cursor:pointer; }
.bc-erro{ font-size:12.5px; color:var(--alert); }
.bc-acts{ display:flex; gap:8px; justify-content:flex-end; }
.bc-btn{ display:inline-flex; align-items:center; gap:6px; border:none; border-radius:10px; padding:11px 16px; font-size:14px; font-weight:800; cursor:pointer; min-height:44px; -webkit-tap-highlight-color:transparent; }
.bc-btn.go{ background:var(--go); color:#062015; }
.bc-btn.ghost{ background:transparent; color:var(--dim); border:1px solid var(--line); }
.bc-list{ display:flex; flex-direction:column; gap:8px; }
.bc-vazio{ padding:22px 4px; text-align:center; color:var(--dim); font-size:13px; }
.bc-item{ display:flex; align-items:flex-start; gap:10px; border:1px solid var(--line); border-radius:12px; padding:11px 12px; background:var(--bg-0); }
.bc-itxt{ flex:1; min-width:0; display:flex; flex-direction:column; gap:3px; }
.bc-ihead{ display:flex; align-items:center; gap:6px; }
.bc-itag{ font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:.03em; color:var(--go); border:1px solid color-mix(in srgb, var(--go) 45%, transparent); border-radius:6px; padding:1px 6px; }
.bc-icat{ font-size:11px; color:var(--dim); }
.bc-inome{ font-size:14.5px; font-weight:700; color:var(--ink); }
.bc-isub{ font-size:12px; color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%; }
.bc-iacts{ flex:none; display:flex; gap:6px; }
.bc-ib{ width:42px; height:42px; border-radius:10px; border:1px solid var(--line); background:var(--bg-1); color:var(--dim); display:grid; place-items:center; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.bc-ib.danger{ color:#fff; background:var(--alert); border-color:var(--alert); }
`;
