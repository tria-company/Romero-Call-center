import * as React from "react";

/* DossieMarkdown — componente PRESENTACIONAL puro compartilhado (PerfilLead +
   Audios). Renderiza o markdown do dossiê (dossie.ts): EXATAMENTE 3 seções
   `## título`, corpo com `**negrito**` e listas `- item`. Dossiê legado/curto
   pode não ter nenhum `## ` — nesse caso o texto inteiro vira uma seção sem
   título. Parse MÍNIMO em TS puro (sem dependência nova); nós montados por
   segmento — NUNCA dangerouslySetInnerHTML com conteúdo cru (T-uef-01).
   LGPD: este componente não loga nada — o caller também não deve logar
   `texto`/`dossie`. */

type Secao = { titulo: string | null; corpo: string[] };

function dividirEmSecoes(texto: string): Secao[] {
  const linhas = texto.split("\n");
  const secoes: Secao[] = [];
  let atual: Secao = { titulo: null, corpo: [] };
  let comecou = false;

  for (const linha of linhas) {
    if (linha.startsWith("## ")) {
      if (comecou || atual.corpo.some((l) => l.trim())) secoes.push(atual);
      atual = { titulo: linha.slice(3).trim(), corpo: [] };
      comecou = true;
    } else {
      atual.corpo.push(linha);
    }
  }
  secoes.push(atual);

  // seção inicial sem título e sem corpo (texto começa direto com "## "): descarta
  return secoes.filter((s) => s.titulo !== null || s.corpo.some((l) => l.trim()));
}

/** Negrito inline: `**texto**` → <strong>. Segmentos ÍMPAR do split viram
 *  <strong>; os pares ficam texto normal. Nunca HTML — só nós React. */
function renderInline(texto: string, chavePrefixo: string): React.ReactNode[] {
  const partes = texto.split(/\*\*(.+?)\*\*/);
  return partes.map((parte, i) =>
    i % 2 === 1 ? <strong key={`${chavePrefixo}-b${i}`}>{parte}</strong> : parte,
  );
}

/** Corpo de uma seção: linhas "- " consecutivas agrupam num <ul>; demais
 *  linhas não-vazias viram <p>. Linhas vazias só separam parágrafos. */
function renderCorpo(linhas: string[], chavePrefixo: string): React.ReactNode[] {
  const nos: React.ReactNode[] = [];
  let listaAtual: string[] = [];
  let idx = 0;

  function fecharLista() {
    if (listaAtual.length === 0) return;
    nos.push(
      <ul className="dm-ul" key={`${chavePrefixo}-ul${idx}`}>
        {listaAtual.map((item, j) => (
          <li className="dm-li" key={`${chavePrefixo}-ul${idx}-li${j}`}>
            {renderInline(item, `${chavePrefixo}-ul${idx}-li${j}`)}
          </li>
        ))}
      </ul>,
    );
    idx++;
    listaAtual = [];
  }

  for (const linhaBruta of linhas) {
    const linha = linhaBruta.trim();
    if (linha.startsWith("- ")) {
      listaAtual.push(linha.slice(2).trim());
      continue;
    }
    fecharLista();
    if (!linha) continue;
    nos.push(
      <p className="dm-p" key={`${chavePrefixo}-p${idx}`}>
        {renderInline(linha, `${chavePrefixo}-p${idx}`)}
      </p>,
    );
    idx++;
  }
  fecharLista();

  return nos;
}

export function DossieMarkdown({ texto }: { texto: string }) {
  if (!texto || !texto.trim()) return null;

  const secoes = dividirEmSecoes(texto);
  if (secoes.length === 0) return null;

  return (
    <div className="dm-root">
      <style>{DM_CSS}</style>
      {secoes.map((secao, i) => (
        <div className="dm-sec" key={i}>
          {secao.titulo && <div className="dm-h">{secao.titulo}</div>}
          {renderCorpo(secao.corpo, `s${i}`)}
        </div>
      ))}
    </div>
  );
}

const DM_CSS = `
.dm-root{ display:flex; flex-direction:column; gap:10px; font-size:12px; line-height:1.55; color:var(--ink); }
.dm-sec{ display:flex; flex-direction:column; gap:4px; }
.dm-sec + .dm-sec{ padding-top:8px; border-top:1px solid var(--line); }
.dm-h{ font-size:11.5px; font-weight:700; color:var(--go); text-transform:uppercase; letter-spacing:.02em; }
.dm-p{ margin:0; color:var(--dim); }
.dm-p strong{ color:var(--ink); font-weight:700; }
.dm-ul{ margin:2px 0; padding-left:16px; display:flex; flex-direction:column; gap:3px; }
.dm-li{ color:var(--dim); }
.dm-li strong{ color:var(--ink); font-weight:700; }
`;
