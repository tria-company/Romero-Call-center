"use client";

import * as React from "react";
import { fmtDiaPorExtenso, saudacao } from "@/lib/format";
import { operadorAtual } from "@/components/shell/BootDados";
import { InstallBanner } from "@/components/shell/InstallPrompt";
import { useFilaReal } from "@/lib/fila-real";
import { useMetricasReais } from "@/lib/metricas-real";
import { BlocoLista, Contador, Metrica, Skels, Vhead } from "./blocos";

/* TELA 01 · INÍCIO
   Só tiles com fonte REAL: a fila de hoje (do discador) e a operação ao vivo
   (métricas agregadas do call center). Sem números de campanha mocados
   (Instagram, urnas, foguete, metas) — esses saíram. Depois dos tiles vem a
   Central de Campanha, que chega por `children`.

   O `children` NÃO É ENFEITE: ele é o que permite a seção de campanha ser um
   componente de SERVIDOR dentro desta tela, que é cliente. Importá-la aqui a
   arrastaria para o cliente. Quem monta o par é `app/(app)/page.tsx`.

   Por isso o `{children}` fica SEMPRE no último índice do `.view`, FORA de
   qualquer condicional de carregamento: enquanto os tiles reais hidratam/pedem
   os dados, só eles viram barras; a campanha já está desenhada embaixo e não
   pisca junto (o "esqueleto eterno" que a versão antiga evitava). */

export function Inicio({ children }: { children?: React.ReactNode }) {
  const [nome, setNome] = React.useState("");
  const relogio = useRelogio();
  const fila = useFilaReal();

  React.useEffect(() => setNome(operadorAtual()), []);

  return (
    <div className="view" aria-busy={fila.carregando || undefined}>
      <Vhead
        titulo={`${saudacao()}, ${nome || "equipe"}`}
        sub={fmtDiaPorExtenso()}
        live={relogio}
      />

      {/* fila de hoje — contagem real do discador */}
      <div className="mrow">
        {fila.carregando ? (
          <Skels alturas={[132]} />
        ) : (
          <Metrica
            valor={<Contador valor={fila.itens.length} />}
            label="Sua fila de hoje"
            delta={fila.erro ? "não foi possível carregar" : undefined}
            alerta={fila.erro}
            href="/fila"
            full
          />
        )}
      </div>

      {/* operação ao vivo — métricas agregadas do call center */}
      <OperacaoAoVivo />

      {/* convite de instalação — some quando dispensado ou já instalado */}
      <InstallBanner />

      {/* a Central de Campanha, depois de tudo o que já existia.
          FORA do condicional de propósito — ver o comentário acima. */}
      {children}
    </div>
  );
}

/**
 * Bloco "Operação ao vivo": quatro números do backend do discador. Nunca quebra
 * a Home — some quando dá erro; mostra esqueleto discreto enquanto carrega ou
 * quando o operador não tem acesso à métrica (o resto da tela segue de pé).
 */
function OperacaoAoVivo() {
  const { metricas, semAcesso, erro } = useMetricasReais();

  // Erro de rede/backend: o bloco some — a fila e a campanha continuam.
  if (erro) return null;

  return (
    <BlocoLista titulo="Operação ao vivo">
      {metricas === null || semAcesso ? (
        <div className="mrow">
          <Skels alturas={[92, 92, 92, 92]} />
        </div>
      ) : (
        <div className="mrow">
          <Metrica
            valor={<Contador valor={metricas.atendentesOnline} />}
            label="Atendentes online"
          />
          <Metrica
            valor={<Contador valor={metricas.chamadasAtivas} />}
            label="Chamadas ativas"
          />
          <Metrica
            valor={<Contador valor={metricas.profundidadeFila} />}
            label="Profundidade da fila"
          />
          <Metrica
            valor={<Contador valor={metricas.errosDia} />}
            label="Erros hoje"
            alerta={metricas.errosDia > 0}
          />
        </div>
      )}
    </BlocoLista>
  );
}

/** Relógio da barra ao vivo. Atualiza no minuto, não no segundo. */
function useRelogio(): string {
  const [hora, setHora] = React.useState("");
  React.useEffect(() => {
    const tick = () =>
      setHora(
        new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
      );
    tick();
    const id = setInterval(tick, 20_000);
    return () => clearInterval(id);
  }, []);
  return hora;
}
