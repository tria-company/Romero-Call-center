"use client";

import * as React from "react";
import { Check, FolderOpen, Pencil, Plus, Trash2, X } from "lucide-react";
import { atualizarConteudo, criarConteudo, excluirConteudo, listarConteudos } from "@/lib/conteudos-real";
import type { ConteudoReal, ConteudoTipo } from "@/lib/conteudos-real";

/* ══════════════════════════════════════════════════════════════════════════
   BibliotecaConteudos — tela de GESTÃO dos conteúdos prontos (Fase 2, Fatia 3).
   O gestor/Romero adiciona, edita, exclui (soft-delete) e categoriza os
   conteúdos que depois aparecem no seletor da conversa. Overlay full-screen,
   mesmo espírito da ficha/pular do Audios. LGPD: sem dado pessoal.
   ══════════════════════════════════════════════════════════════════════════ */

export function BibliotecaConteudos({ aoFechar }: { aoFechar: () => void }) {
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
    if (!t) {
      setErro("Título é obrigatório.");
      return;
    }
    if (tipo === "link" && !url.trim()) {
      setErro("URL é obrigatória para tipo link.");
      return;
    }
    if (tipo === "texto" && !texto.trim()) {
      setErro("Texto é obrigatório para tipo texto.");
      return;
    }
    setSalvando(true);
    setErro("");
    const dados = {
      categoria: categoria.trim() || null,
      titulo: t,
      tipo,
      texto: tipo === "texto" ? texto : null,
      url: tipo === "link" ? url.trim() : null,
    };
    const r = editando ? await atualizarConteudo(editando.id, dados) : await criarConteudo(dados);
    setSalvando(false);
    if (!r) {
      setErro("Não deu para salvar. Tente de novo.");
      return;
    }
    limparForm();
    await recarregar();
  }

  async function remover(id: string) {
    const ok = await excluirConteudo(id);
    setConfirmandoExcluir(null);
    if (ok) {
      if (editando?.id === id) limparForm();
      await recarregar();
    }
  }

  return (
    <div className="bc-overlay" role="dialog" aria-modal="true" aria-label="Gerenciar conteúdos">
      <style>{BC_CSS}</style>
      <div className="bc-head">
        <div className="bc-htit">
          <FolderOpen size={18} /> Gerenciar conteúdos
        </div>
        <button type="button" className="bc-x" onClick={aoFechar} aria-label="Fechar">
          <X size={20} />
        </button>
      </div>

      <div className="bc-body">
        {/* formulário de adicionar/editar */}
        <div className="bc-form">
          <div className="bc-formtit">{editando ? "Editar conteúdo" : "Novo conteúdo"}</div>
          <div className="bc-row">
            <input className="bc-in" placeholder="Categoria (ex.: Resgates)" value={categoria} onChange={(e) => setCategoria(e.target.value)} maxLength={60} />
            <div className="bc-seg">
              <button type="button" className={"bc-segb" + (tipo === "link" ? " on" : "")} onClick={() => setTipo("link")}>
                Link
              </button>
              <button type="button" className={"bc-segb" + (tipo === "texto" ? " on" : "")} onClick={() => setTipo("texto")}>
                Texto
              </button>
            </div>
          </div>
          <input className="bc-in" placeholder="Título (ex.: Instagram do Romero)" value={titulo} onChange={(e) => setTitulo(e.target.value)} maxLength={120} />
          {tipo === "link" ? (
            <input className="bc-in" placeholder="URL (https://…)" value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" maxLength={2000} />
          ) : (
            <textarea className="bc-ta" placeholder="Texto da mensagem" value={texto} onChange={(e) => setTexto(e.target.value)} rows={3} maxLength={4096} />
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
                  <div className="bc-isub">{c.tipo === "link" ? (c.url ?? "") : (c.texto ?? "")}</div>
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
    </div>
  );
}

const BC_CSS = `
.bc-overlay{ position:fixed; inset:0; z-index:320; background:var(--bg-0, #0b0f0d); display:flex; flex-direction:column; }
.bc-head{ flex:none; display:flex; align-items:center; justify-content:space-between; padding:14px 16px calc(14px); border-bottom:1px solid var(--line); }
.bc-htit{ display:flex; align-items:center; gap:8px; font-size:16px; font-weight:800; color:var(--ink); }
.bc-x{ width:38px; height:38px; border-radius:50%; border:1px solid var(--line); background:var(--bg-1); color:var(--dim); display:grid; place-items:center; cursor:pointer; }
.bc-body{ flex:1; overflow-y:auto; padding:14px 16px calc(24px + var(--safe-b)); display:flex; flex-direction:column; gap:16px; -webkit-overflow-scrolling:touch; }
.bc-form{ display:flex; flex-direction:column; gap:9px; border:1px solid var(--line); border-radius:14px; padding:13px; background:var(--bg-1); }
.bc-formtit{ font-size:13px; font-weight:800; color:var(--ink); }
.bc-row{ display:flex; gap:9px; }
.bc-in{ flex:1; min-width:0; height:42px; padding:0 12px; border:1px solid var(--line); border-radius:10px; background:var(--bg-0, #0b0f0d); color:var(--ink); font-size:14px; outline:none; }
.bc-ta{ width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:var(--bg-0, #0b0f0d); color:var(--ink); font-size:14px; outline:none; resize:vertical; font-family:inherit; }
.bc-in::placeholder,.bc-ta::placeholder{ color:var(--dim); }
.bc-seg{ flex:none; display:flex; border:1px solid var(--line); border-radius:10px; overflow:hidden; }
.bc-segb{ padding:0 14px; height:42px; border:none; background:var(--bg-0, #0b0f0d); color:var(--dim); font-size:13px; font-weight:700; cursor:pointer; }
.bc-segb.on{ background:var(--go); color:#062015; }
.bc-erro{ font-size:12.5px; color:var(--alert); }
.bc-acts{ display:flex; gap:8px; justify-content:flex-end; }
.bc-btn{ display:inline-flex; align-items:center; gap:6px; border:none; border-radius:10px; padding:10px 16px; font-size:13px; font-weight:800; cursor:pointer; }
.bc-btn.go{ background:var(--go); color:#062015; }
.bc-btn.ghost{ background:transparent; color:var(--dim); border:1px solid var(--line); }
.bc-list{ display:flex; flex-direction:column; gap:8px; }
.bc-vazio{ padding:22px 4px; text-align:center; color:var(--dim); font-size:13px; }
.bc-item{ display:flex; align-items:flex-start; gap:10px; border:1px solid var(--line); border-radius:12px; padding:11px 12px; background:var(--bg-1); }
.bc-itxt{ flex:1; min-width:0; display:flex; flex-direction:column; gap:3px; }
.bc-ihead{ display:flex; align-items:center; gap:6px; }
.bc-itag{ font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:.03em; color:var(--go); border:1px solid color-mix(in srgb, var(--go) 45%, transparent); border-radius:6px; padding:1px 6px; }
.bc-icat{ font-size:11px; color:var(--dim); }
.bc-inome{ font-size:14px; font-weight:700; color:var(--ink); }
.bc-isub{ font-size:12px; color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%; }
.bc-iacts{ flex:none; display:flex; gap:6px; }
.bc-ib{ width:36px; height:36px; border-radius:9px; border:1px solid var(--line); background:var(--bg-0, #0b0f0d); color:var(--dim); display:grid; place-items:center; cursor:pointer; }
.bc-ib.danger{ color:#fff; background:var(--alert); border-color:var(--alert); }
`;
