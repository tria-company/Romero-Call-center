"use client";

import * as React from "react";
import { ChevronDown, Mic, Phone } from "lucide-react";
// Helper PURO de iniciais — fora de qualquer store/localStorage.
import { iniciais } from "@/lib/leads-util";
import type { ItemFilaReal } from "@/lib/discador-servidor";
import { useFilaReal } from "@/lib/fila-real";
import { fmtTelefone, urlCallCenter, vibrar } from "@/lib/contato";
import { Autobox, Esqueleto, Vhead } from "./blocos";
import { Audios } from "./Audios";

/* TELA 02 · AÇÕES DE HOJE (ex-Fila)
   Fonte da fila: a fila REAL do discador (Ligações abertas do dia do Romero),
   servida por /api/mobile/fila. Sem localStorage, sem selo de motivo (o backend
   não manda), sem marcar-feito: quando a Ligação recebe desfecho ela some no
   próximo fetch. O visual (Vhead, qbar, cards `.task`) segue o mockup.

   ENVIO-08: para o gestor/admin esta aba ("Ações") concentra as DUAS ações do
   dia atrás de um DROPDOWN no título — "Fila de ligação" ↔ "Áudios" (lista de
   nunca-ligados, embutida via <Audios embutido/>). Uma vista por vez; a última
   escolha fica em sessionStorage pra aba reabrir onde o gestor estava. O
   dropdown só monta pro romero (`podeAudios`) — o gate real é o backend
   (`exigirRomero`). Atendente vê só a fila (podeAudios=false, título "Fila de hoje").

   u14: o CARD INTEIRO liga — tocar em qualquer lugar do card faz a mesma ação do
   botão "Ligar" (handoff pro discador). A ficha do lead saiu da Fila; o botão
   "Ligar" segue como affordance explícita. */

type Vista = "fila" | "audios";
const CHAVE_VISTA = "acoes.vista";

export function Fila({
  papel = "atendente",
  podeAudios = false,
}: {
  papel?: "gestor" | "atendente";
  podeAudios?: boolean;
} = {}) {
  const { itens, carregando, erro, semMapeamento, recarregar } = useFilaReal();

  /* Token do call center, buscado ao MONTAR e não ao tocar em "Ligar": o
     bloqueador de pop-ups só deixa `window.open` passar dentro do gesto, e um
     `await` no meio já o invalida. Com o token pronto, o toque abre a aba
     síncrono. Sem token, abre a URL nua e o operador digita a senha. */
  const [tokenCC, setTokenCC] = React.useState<string | null>(null);

  React.useEffect(() => {
    let vivo = true;
    fetch("/api/callcenter/token", { method: "POST" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (vivo) setTokenCC(d?.token ?? null);
      })
      .catch(() => {
        /* call center fora do ar: o botão degrada para login manual */
      });
    return () => {
      vivo = false;
    };
  }, []);

  // Chamado no gesto do toque. MESMO ENDERECO (u7): navega na MESMA aba pro
  // discador (mesma origem) — sem abrir aba nova órfã. A fila já tem a Ligação
  // (item.taskId), então passa &task pro discador abrir a chamada exata (auto-
  // loga por #token). Ao VOLTAR, o discador devolve o gestor pra ESTA fila (/fila).
  function ligar(item: ItemFilaReal) {
    vibrar();
    window.location.href = urlCallCenter(tokenCC, item.taskId);
  }

  /* ENVIO-08: dentro de "Ações", o DROPDOWN do título troca a vista. A última
     escolha persiste em sessionStorage (só leitura pós-mount, pra não divergir
     do HTML do servidor na hidratação). */
  const [vista, setVistaEstado] = React.useState<Vista>("fila");
  const [menuAberto, setMenuAberto] = React.useState(false);
  React.useEffect(() => {
    try {
      if (window.sessionStorage.getItem(CHAVE_VISTA) === "audios") setVistaEstado("audios");
    } catch {
      /* sessionStorage indisponível: abre na fila */
    }
  }, []);
  function escolherVista(v: Vista) {
    setVistaEstado(v);
    setMenuAberto(false);
    try {
      window.sessionStorage.setItem(CHAVE_VISTA, v);
    } catch {
      /* best-effort */
    }
  }

  /* Conteúdo da vista LIGAR — estados inline (sem early-return da tela toda:
     o cabeçalho com o dropdown fica de pé mesmo com a fila carregando/errada). */
  const secaoLigar = carregando ? (
    <Esqueleto alturas={[64, 86]} />
  ) : erro ? (
    <div className="empty">
      <b>Não deu para carregar a fila</b>
      <button type="button" className="seg" style={{ marginTop: 10 }} onClick={recarregar}>
        toque para tentar de novo
      </button>
    </div>
  ) : semMapeamento ? (
    <Autobox tom="warn" titulo="Fila não configurada">
      Configure o mapeamento do operador no discador (painel /admin do call center).
    </Autobox>
  ) : (
    <>
      <div className="qbar">
        <div className="qtop">
          <b>{itens.length}</b>
          <span>
            {itens.length > 0
              ? itens.length === 1
                ? "última ligação de hoje"
                : "na fila hoje — ligue a próxima"
              : "fila zerada hoje"}
          </span>
        </div>
      </div>

      {itens.length === 0 ? (
        <div className="empty">
          <b>Fila zerada</b>
          Você falou com todo mundo que o sistema separou para hoje.
        </div>
      ) : (
        /* u14: mostra só o PRÓXIMO lead (o backend já ordena por prioridade).
           Ao ligar e voltar pra cá, a fila recarrega e o próximo vira o topo. */
        <CardFila key={itens[0].taskId} item={itens[0]} indice={0} onLigar={ligar} />
      )}
    </>
  );

  // Atendente (e gestor sem áudios): a tela de sempre, sem dropdown.
  if (!podeAudios) {
    return (
      <div className="view">
        <Vhead titulo={papel === "gestor" ? "Ações de hoje" : "Fila de hoje"} sub="ordenada pelo sistema" live="ao vivo" />
        {secaoLigar}
      </div>
    );
  }

  // Romero: cabeçalho com DROPDOWN (Fila de ligação ↔ Áudios), uma vista por vez.
  return (
    <div className="view">
      <style>{AC_CSS}</style>

      <div className="vhead">
        <div style={{ minWidth: 0, position: "relative" }}>
          <button
            type="button"
            className={"ac-dd" + (menuAberto ? " open" : "")}
            onClick={() => setMenuAberto((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuAberto}
          >
            <span className="ds-truncate">{vista === "fila" ? "Fila de ligação" : "Áudios"}</span>
            <ChevronDown size={22} className="ac-chev" />
          </button>
          <div className="sub">{vista === "fila" ? "ordenada pelo sistema" : "mande áudio pros nunca-ligados"}</div>

          {menuAberto && (
            <>
              <div className="ac-ddback" onClick={() => setMenuAberto(false)} />
              <div className="ac-menu" role="menu">
                <button type="button" role="menuitem" className={"ac-mi" + (vista === "fila" ? " sel" : "")} onClick={() => escolherVista("fila")}>
                  <Phone size={18} />
                  <span>
                    Fila de ligação<small>ligações do dia</small>
                  </span>
                </button>
                <button type="button" role="menuitem" className={"ac-mi" + (vista === "audios" ? " sel" : "")} onClick={() => escolherVista("audios")}>
                  <Mic size={18} />
                  <span>
                    Áudios<small>mandar áudio pros nunca-ligados</small>
                  </span>
                </button>
              </div>
            </>
          )}
        </div>

        <div className="live">
          <span className="pulse" />
          ao vivo
        </div>
      </div>

      {vista === "fila" && secaoLigar}

      {/* <Audios> fica SEMPRE montado, só escondido quando a vista é a fila:
          o lote real (varredura ClickUp) leva ~10-15s — montando junto com a
          aba, a lista já chega PRONTA quando o gestor abre o dropdown, e
          trocar de vista não re-busca (o hook segue vivo, com poll de 30s). */}
      <div style={{ display: vista === "audios" ? undefined : "none" }}>
        <Audios embutido />
      </div>
    </div>
  );
}

/* Estilos do dropdown de "Ações" (prefixo ac- pra não colidir com o au- da
   tela de áudios). O título-botão imita o h1 do .vhead. */
const AC_CSS = `
.ac-dd{ display:flex; align-items:center; gap:6px; background:none; border:none; color:var(--ink); cursor:pointer; padding:0; font-size:26px; font-weight:800; letter-spacing:-.01em; line-height:1.15; max-width:100%; -webkit-tap-highlight-color:transparent; }
.ac-chev{ flex:none; transition:transform .2s; opacity:.8; }
.ac-dd.open .ac-chev{ transform:rotate(180deg); }
.ac-ddback{ position:fixed; inset:0; z-index:40; }
.ac-menu{ position:absolute; top:42px; left:0; z-index:41; background:var(--bg-1); border:1px solid var(--line-2); border-radius:16px; overflow:hidden; box-shadow:0 16px 40px rgba(0,0,0,.5); min-width:260px; animation:acPop .16s ease both; }
@keyframes acPop{ from{ opacity:0; transform:translateY(-8px) scale(.98); } to{ opacity:1; transform:none; } }
.ac-mi{ display:flex; align-items:center; gap:12px; padding:14px 16px; cursor:pointer; font-size:15px; font-weight:600; color:var(--ink); background:none; border:none; width:100%; text-align:left; -webkit-tap-highlight-color:transparent; }
.ac-mi:active{ background:var(--card); }
.ac-mi + .ac-mi{ border-top:1px solid var(--line); }
.ac-mi.sel{ color:var(--go); }
.ac-mi small{ display:block; color:var(--dim-2); font-size:11.5px; font-weight:500; margin-top:2px; }
@media (prefers-reduced-motion:reduce){ .ac-menu,.ac-chev{ animation:none!important; transition:none!important; } }
`;

function CardFila({
  item,
  indice,
  onLigar,
}: {
  item: ItemFilaReal;
  indice: number;
  onLigar: (item: ItemFilaReal) => void;
}) {
  // u14: o CARD INTEIRO liga. Tocar em qualquer lugar do card dispara `onLigar`
  // (mesma ação do botão). O botão "Ligar" fica como affordance explícita e
  // dá stopPropagation pra não disparar duas vezes. A ficha saiu da Fila.
  return (
    <div
      className="task"
      onClick={() => onLigar(item)}
      style={{
        cursor: "pointer",
        animation: `reveal-up 380ms var(--ease-out-soft) ${Math.min(indice, 8) * 40}ms backwards`,
      }}
    >
      <div className="av">{iniciais(item.nome)}</div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="tn trunc">{item.nome}</div>
        {/* Telefone exibido ao operador autorizado — nunca logar (LGPD). */}
        <div className="tm trunc">{fmtTelefone(item.telefone)}</div>
      </div>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onLigar(item);
        }}
        className="go"
        aria-label="Ligar"
      >
        Ligar
      </button>
    </div>
  );
}
