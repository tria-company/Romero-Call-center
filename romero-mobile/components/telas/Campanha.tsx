"use client";

import type { ReactNode } from "react";
import { type BarraCampanha, type IntencaoVoto } from "@/lib/campanha";
import { useCampanhaReal } from "@/lib/campanha-real";
import { fmtInt, fmtMinSeg } from "@/lib/format";
import { COR, GraficoAcumulado, GraficoProducao, Tendencias } from "./CampanhaGraficos";
import { Ranking } from "./RankingCampanha";

/* ══════════════════════════════════════════════════════════════════════════
   CENTRAL DE CAMPANHA · portada de `ROMERO/central-campanha-romero.html`

   É uma SEÇÃO do Início, não uma tela. Entra depois das duas urnas, no fim da
   coluna — foi o pedido, e a rota `/campanha` e a sexta aba deixaram de
   existir junto. Por isso este componente não desenha `.view`: quem desenha é
   o Início, e daqui sai só o miolo, embrulhado em `.cc`.

   A ordem dos blocos é a do MOBILE daquele arquivo, de cima para baixo:

     cabeçalho → acumulado vs meta → produção diária → tendências → comparativo
     → tempo médio → intenção → ranking → votos por cidade → motivos de
     não-contato → retornos/SLA

   No mockup essa ordem é a mesma nas duas larguras; o desktop só junta alguns
   cartões em duas ou três colunas. Aqui existe só a coluna única — foi o
   pedido, e é como todas as outras telas do app já se comportam.

   A ABERTURA DO MOCKUP FOI RETIRADA a pedido: o alternador Campanha/Semana/
   Hoje, as pílulas "demonstração" e "ao vivo", a linha "Dia 12 de 30" e os
   dois cartões de meta das urnas. Os números daqueles cartões continuam em
   `lib/campanha.ts` (`metas`, `dia`, `inicio`, `eleicao`), marcados como sem
   consumidor — devolver é remontar o bloco, não redigitar o mockup.

   ESTA SEÇÃO NÃO É CLIENTE, e é isso que a mantém fora do esqueleto do Início.
   Ela desenha números fixos, então o servidor a renderiza e ela chega pronta;
   o Início a recebe como `children` (componente de servidor atravessando um
   componente cliente), e por isso ela aparece de primeira mesmo enquanto o
   resto da tela ainda espera o localStorage hidratar. A única ilha interativa
   é o `<Ranking>`, que precisa de estado para o seletor de ordenação.

   Os números aqui são de OUTRA operação, não outra visão da mesma: "votos
   confirmados" pelo telemarketing (18.240) não é "apoio confirmado" da base
   local (14.208, logo acima na mesma tela). Cruzá-los faria dois números
   diferentes disputarem o mesmo nome — daí o cabeçalho que separa as duas.
   ══════════════════════════════════════════════════════════════════════════ */

export function SecaoCampanha() {
  const campanha = useCampanhaReal();
  const c = campanha.dados;
  /* Sem série de votos datada, o gráfico de acumulado não tem o que plotar. */
  const temAcumulado = c.serie.some((d) => d.acumulado > 0);
  /* SLA e cobertura não são zero: são AUSENTES (a rota não os devolve). Um contador
     qualquer acima de zero é o sinal de que a fonte passou a existir. */
  const temSla = c.sla.agendados > 0 || c.sla.cumpridos > 0 || c.sla.vencidos > 0;
  const temCobertura = c.cobertura.total > 0;

  return (
    <section className="cc" aria-labelledby="secao-campanha">
      {/* ── cabeçalho ────────────────────────────────────────────────────── */}
      <div className="top">
        <div className="brand">
          {/* h2: o h1 da página é o cumprimento do Início */}
          <h2 id="secao-campanha">Central de Campanha</h2>
          <div className="sub">
            Gabinete Romero · telemarketing eleitoral
            {c.equipeTotal > 0 ? ` · ${fmtInt(c.equipeTotal)} telefonistas` : ""}
          </div>
        </div>
      </div>

      {/* ── acumulado vs meta ────────────────────────────────────────────── */}
      <div className="card">
        <p className="eyebrow">Votos confirmados acumulados vs meta · toda a campanha</p>
        {temAcumulado ? (
          <>
            <GraficoAcumulado
              serie={c.serie}
              meta={c.metaGrafico}
              totalDias={c.totalDias}
              diaProjecao={c.diaProjecao}
            />
            <div className="clegend">
              <span>
                <i style={{ background: "var(--accent)" }} />
                realizado ({fmtInt(c.serie[c.serie.length - 1].acumulado)})
              </span>
              <span>
                <i style={{ background: "var(--faint)" }} />
                meta ideal
              </span>
              {c.diaProjecao > 0 && (
                <span>
                  <i className="proj" />
                  projeção → bate a meta ~dia {c.diaProjecao}
                </span>
              )}
            </div>
          </>
        ) : (
          <SemDados>
            A confirmação de voto no ClickUp não guarda data, então não há série
            histórica para desenhar.
          </SemDados>
        )}
      </div>

      {/* ── produção diária ──────────────────────────────────────────────── */}
      <div className="card">
        <p className="eyebrow">Produção diária · ligações e contatos ({c.serie.length} dias)</p>
        {c.serie.length > 0 ? (
          <>
            <GraficoProducao serie={c.serie} />
            <div className="clegend">
              <span>
                <i className="lig" />
                ligações
              </span>
              <span>
                <i style={{ background: "var(--good)" }} />
                contatos
              </span>
            </div>
          </>
        ) : (
          <SemDados>Nenhuma ligação registrada ainda.</SemDados>
        )}
      </div>

      {/* ── tendências ───────────────────────────────────────────────────── */}
      <div className="card">
        <p className="eyebrow">Tendências (semanal)</p>
        {c.tendencias.length > 0 ? (
          <Tendencias itens={c.tendencias} />
        ) : (
          <SemDados>Precisa de semanas de histórico para comparar.</SemDados>
        )}
      </div>

      {/* ── comparativo ──────────────────────────────────────────────────── */}
      <div className="card">
        <p className="eyebrow">Comparativo · semana vs anterior</p>
        {c.comparativo.length === 0 && (
          <SemDados>Precisa de duas semanas de operação para comparar.</SemDados>
        )}
        <table>
          <tbody>
            {c.comparativo.map((l) => (
              <tr key={l.rotulo}>
                <td>{l.rotulo}</td>
                <td className="tabnum">{l.valor}</td>
                <td className={l.sentido}>{l.delta}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── tempo médio ──────────────────────────────────────────────────── */}
      <div className="card">
        <p className="eyebrow">Tempo médio de ligação · geral</p>
        <div className="val tabnum">{fmtMinSeg(c.tempoMedio.atual)}</div>
        <div className="lab">
          faixa saudável {fmtMinSeg(c.tempoMedio.faixa[0])}–{fmtMinSeg(c.tempoMedio.faixa[1])}
        </div>
        <div className="progress g">
          <span style={{ width: `${c.tempoMedio.pct}%` }} />
        </div>
        <div className="metrow">
          <Met valor={fmtMinSeg(c.tempoMedio.min)} label="mín" />
          <Met valor={fmtMinSeg(c.tempoMedio.mediana)} label="mediana" />
          <Met valor={fmtMinSeg(c.tempoMedio.max)} label="máx" />
        </div>
        <div className="lab aviso">
          ⚠️ &lt;{fmtMinSeg(c.tempoMedio.faixa[0])} = ligação empurrada (baixa conversão)
        </div>
      </div>

      {/* ── intenção de voto ─────────────────────────────────────────────── */}
      <div className="card">
        <p className="eyebrow">Intenção de voto</p>
        {c.intencao.map((i, idx) => (
          <Intencao key={i.rotulo} i={i} primeiro={idx === 0} />
        ))}
      </div>

      {/* ── ranking (única parte interativa) ─────────────────────────────── */}
      <Ranking
        telefonistas={c.telefonistas}
        equipeTotal={c.equipeTotal}
        semOperador={campanha.semOperador}
      />

      {/* ── três recortes finais ─────────────────────────────────────────── */}
      <div className="card">
        <p className="eyebrow">Votos por cidade</p>
        {c.votosPorCidade.length === 0 ? (
          <SemDados>Nenhum voto confirmado com cidade preenchida.</SemDados>
        ) : (
          c.votosPorCidade.map((b) => <Barra key={b.rotulo} b={b} />)
        )}
      </div>

      <div className="card">
        <p className="eyebrow">Motivos de não-contato</p>
        {c.motivosNaoContato.length === 0 ? (
          <SemDados>Nenhuma tentativa sem contato registrada.</SemDados>
        ) : (
          c.motivosNaoContato.map((b) => <Barra key={b.rotulo} b={b} />)
        )}
      </div>

      {/* Os dois blocos abaixo NÃO têm fonte hoje: a rota /api/discador/campanha agrega a
          Lista 02 e não devolve `sla` nem `cobertura`, então os dois caem no fallback
          zerado de CAMPANHA_REAL_VAZIO. Sem guarda, o SLA publicava "0% no prazo" — que
          se lê como medição catastrófica, não como ausência — e a cobertura calculava
          0 ÷ 0 e imprimia literalmente "0 de 0 · NaN%" na tela. Mesma regra do resto do
          painel: cartão no lugar, `eyebrow` no lugar, e uma frase dizendo POR QUE não há
          número. */}
      <div className="card">
        <p className="eyebrow">Retornos / SLA</p>
        {temSla ? (
          <>
            <div className="valrow">
              <div className="val tabnum">{c.sla.pct}%</div>
              <span className="lab">no prazo</span>
            </div>
            <div className="progress g">
              <span style={{ width: `${c.sla.pct}%` }} />
            </div>
            <div className="metrow">
              <Met valor={fmtInt(c.sla.agendados)} label="agendados" />
              <Met valor={fmtInt(c.sla.cumpridos)} label="cumpridos" tom="up" />
              <Met valor={fmtInt(c.sla.vencidos)} label="vencidos" tom="down" />
            </div>
          </>
        ) : (
          <SemDados>
            Nenhum retorno agendado foi medido ainda — a agregação da campanha ainda não
            lê a data de retorno das ligações.
          </SemDados>
        )}
        <div className="gap8" />
        <p className="eyebrow">Cobertura da base</p>
        {temCobertura ? (
          <>
            <div className="lab">
              {fmtInt(c.cobertura.feita)} de {fmtInt(c.cobertura.total)} ·{" "}
              {Math.round((c.cobertura.feita / c.cobertura.total) * 100)}%
            </div>
            <div className="progress">
              <span style={{ width: `${(c.cobertura.feita / c.cobertura.total) * 100}%` }} />
            </div>
          </>
        ) : (
          <SemDados>
            A agregação da campanha ainda não cruza as ligações feitas com o tamanho da
            base, então não há percentual de cobertura para mostrar.
          </SemDados>
        )}
      </div>
    </section>
  );
}

/* ── Peças pequenas ────────────────────────────────────────────────────── */

function Met({ valor, label, tom }: { valor: string; label: string; tom?: "up" | "down" }) {
  return (
    <div>
      <div className={tom ? `mv tabnum ${tom}` : "mv tabnum"}>{valor}</div>
      <div className="ml">{label}</div>
    </div>
  );
}

function Intencao({ i, primeiro }: { i: IntencaoVoto; primeiro: boolean }) {
  return (
    <>
      <div className={primeiro ? "lab intlab primeiro" : "lab intlab"}>
        {i.rotulo} · base {fmtInt(i.base)}
      </div>
      <div className="stack">
        <span style={{ width: `${i.sim}%`, background: "var(--good)" }}>Sim {i.sim}%</span>
        <span style={{ width: `${i.nao}%`, background: "var(--crit)" }}>{i.nao}%</span>
        <span style={{ width: `${i.nd}%`, background: "var(--faint)" }}>ND {i.nd}%</span>
      </div>
    </>
  );
}

function Barra({ b }: { b: BarraCampanha }) {
  return (
    <div className="cbar">
      <span className="lbl">{b.rotulo}</span>
      <span className="track">
        <span style={{ width: `${b.pct}%`, background: COR[b.tom] }} />
      </span>
      <span className="n">{b.valor}</span>
    </div>
  );
}

/**
 * Estado vazio de um cartão. NÃO muda o layout: o cartão continua no mesmo
 * lugar, com o mesmo `eyebrow` — só o miolo troca o número por uma frase que
 * explica POR QUE não há número. Melhor do que um zero que parece medição.
 */
function SemDados({ children }: { children: ReactNode }) {
  return (
    <div className="lab" style={{ padding: "14px 0", opacity: 0.7 }}>
      {children}
    </div>
  );
}
