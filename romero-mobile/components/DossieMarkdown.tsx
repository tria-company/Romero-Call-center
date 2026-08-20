import * as React from "react";

/* DossieMarkdown — componente PRESENTACIONAL puro compartilhado (PerfilLead +
   Audios). Renderiza o dossiê do lead.

   IMPORTANTE: o dossiê chega do ClickUp via `task.description`, que já vem SEM
   markdown (o ClickUp remove `##`/`**`). Então, na prática, os títulos de seção
   costumam chegar como linhas cruas ("Identificação", "Histórico e ação",
   "Gancho para o áudio") e os campos como "Rótulo: valor". O parse aqui é
   robusto aos DOIS formatos (com ou sem markdown):
     - título de seção: linha "#"-prefixada, linha inteira em **negrito**, ou
       linha que casa (normalizada) com um dos títulos conhecidos do dossiê;
     - campo: linha "Rótulo: valor" → rótulo apagado + valor em destaque;
     - "não informado": recuado (some visualmente) pra o que importa saltar;
     - valor entre aspas (a fala sugerida do gancho): vira um callout destacado.

   Parse MÍNIMO em TS puro (sem dependência nova); nós montados por segmento —
   NUNCA dangerouslySetInnerHTML com conteúdo cru (T-uef-01). LGPD: este
   componente não loga nada — o caller também não deve logar `texto`/`dossie`. */

type Secao = { titulo: string | null; corpo: string[] };

/** minúsculas, sem acento, sem espaço/pontuação/":" nas pontas. */
function normalizar(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/^[\s:.\-]+|[\s:.\-]+$/g, "");
}

const TITULOS_CONHECIDOS = new Set(
  ["Identificação", "Histórico e ação", "Gancho para o áudio"].map(normalizar),
);

const RE_CAMPO = /^([^:]{1,45}):\s+(.+)$/;
const RE_ASPAS = /^["'“”«»]/;

/** true se a linha (já trimada) é um título de seção. */
function ehTitulo(linha: string): boolean {
  if (/^#{1,3}\s+/.test(linha)) return true;
  if (/^\*\*.+\*\*$/.test(linha)) return true;
  return TITULOS_CONHECIDOS.has(normalizar(linha));
}

/** Texto exibível do título: remove marcadores markdown (#/**). */
function limparTitulo(linha: string): string {
  return linha.replace(/^#{1,3}\s+/, "").replace(/^\*\*|\*\*$/g, "").trim();
}

function ehNaoInformado(s: string): boolean {
  return normalizar(s) === "nao informado";
}

function dividirEmSecoes(texto: string): Secao[] {
  const linhas = texto.split("\n");
  const secoes: Secao[] = [];
  let atual: Secao = { titulo: null, corpo: [] };
  let comecou = false;

  for (const linhaBruta of linhas) {
    const linha = linhaBruta.trim();
    if (linha && ehTitulo(linha)) {
      if (comecou || atual.corpo.some((l) => l.trim())) secoes.push(atual);
      atual = { titulo: limparTitulo(linha), corpo: [] };
      comecou = true;
    } else {
      atual.corpo.push(linhaBruta);
    }
  }
  secoes.push(atual);

  // seção inicial vazia (texto começa direto com um título): descarta
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

/** Valor de um campo: aspas → callout destacado; "não informado" → recuado. */
function renderValor(valor: string, chave: string): React.ReactNode {
  if (RE_ASPAS.test(valor)) {
    return (
      <div className="dm-quote" key={`${chave}-q`}>
        {renderInline(valor, `${chave}-q`)}
      </div>
    );
  }
  const cls = ehNaoInformado(valor) ? "dm-value dm-vazio" : "dm-value";
  return (
    <span className={cls} key={`${chave}-v`}>
      {renderInline(valor, `${chave}-v`)}
    </span>
  );
}

/** Corpo de uma seção: "- " consecutivas agrupam num <ul>; "Rótulo: valor"
 *  vira campo rótulo+valor; demais linhas não-vazias viram <p>. */
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

    const campo = RE_CAMPO.exec(linha);
    if (campo) {
      const rotulo = campo[1].trim();
      const valor = campo[2].trim();
      const emColuna = RE_ASPAS.test(valor); // callout fica ABAIXO do rótulo
      nos.push(
        <div
          className={emColuna ? "dm-field dm-field-col" : "dm-field"}
          key={`${chavePrefixo}-f${idx}`}
        >
          <span className="dm-label">{rotulo}:</span>
          {renderValor(valor, `${chavePrefixo}-f${idx}`)}
        </div>,
      );
      idx++;
      continue;
    }

    const clsP = ehNaoInformado(linha) ? "dm-p dm-vazio" : "dm-p";
    nos.push(
      <p className={clsP} key={`${chavePrefixo}-p${idx}`}>
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
.dm-root{ display:flex; flex-direction:column; gap:14px; font-size:12.5px; line-height:1.5; color:var(--ink); }
.dm-sec{ display:flex; flex-direction:column; gap:6px; }
.dm-sec + .dm-sec{ padding-top:12px; border-top:1px solid var(--line); }
.dm-h{ font-size:11px; font-weight:800; color:var(--go); text-transform:uppercase; letter-spacing:.07em; margin-bottom:2px; }
.dm-field{ display:flex; flex-wrap:wrap; align-items:baseline; gap:2px 6px; }
.dm-field-col{ flex-direction:column; align-items:stretch; gap:4px; }
.dm-label{ color:var(--dim); font-weight:500; flex:none; }
.dm-value{ color:var(--ink); font-weight:600; }
.dm-vazio{ color:var(--dim); font-weight:400; font-style:italic; }
.dm-p{ margin:0; color:var(--ink); }
.dm-p.dm-vazio{ color:var(--dim); }
.dm-p strong, .dm-value strong, .dm-li strong, .dm-quote strong{ color:var(--ink); font-weight:700; }
.dm-quote{ margin:0; padding:8px 10px; border-left:2px solid var(--go); background:rgba(52,208,127,0.08); border-radius:4px; color:var(--ink); font-weight:500; line-height:1.5; }
.dm-ul{ margin:2px 0; padding-left:16px; display:flex; flex-direction:column; gap:3px; }
.dm-li{ color:var(--ink); }
`;
