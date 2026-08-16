"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { iniciais } from "@/lib/leads-util";
import { fmtInt } from "@/lib/format";
import { useFilaReal } from "@/lib/fila-real";
import { operadorAtual } from "@/components/shell/BootDados";
import { InstallPrompt } from "@/components/shell/InstallPrompt";
import { Metrica, Vhead } from "./blocos";

/* TELA · PERFIL (do operador)
   A última aba da navegação. Sem store local: a identidade do operador vive só
   em `localStorage['ca.operador']` (lido/escrito aqui) e o único número é a
   contagem da fila REAL do discador. Nada de base de exemplo, exportar JSON ou
   campanha — tudo isso saiu com o localStorage. */

export function Perfil() {
  const router = useRouter();
  const { itens } = useFilaReal();

  const [nome, setNome] = React.useState("");
  const [saindo, setSaindo] = React.useState(false);

  React.useEffect(() => setNome(operadorAtual()), []);

  function salvarNome(v: string) {
    setNome(v);
    try {
      localStorage.setItem("ca.operador", v.trim() || "Romero");
    } catch {
      /* armazenamento bloqueado; o nome vale só nesta sessão */
    }
  }

  async function sair() {
    setSaindo(true);
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="view">
      <Vhead titulo="Perfil" sub="quem está operando o sistema" />

      <div className="prof">
        <div className="pav">{iniciais(nome || "Romero")}</div>
        <div style={{ minWidth: 0 }}>
          <div className="pn trunc">{nome || "Romero"}</div>
          <div className="pm">Central Animal · gabinete</div>
        </div>
      </div>

      {/* logo abaixo da identidade: é o primeiro lugar onde se procura */}
      <InstallPrompt />

      <div>
        <div className="flabel">Seu nome</div>
        <input
          className="field"
          value={nome}
          onChange={(e) => salvarNome(e.target.value)}
          placeholder="Como você aparece nos registros"
          maxLength={40}
        />
        <p className="dim2" style={{ fontSize: 10.5, marginTop: 6, lineHeight: 1.5 }}>
          É este nome que aparece no cumprimento do Início e nos registros que você faz.
        </p>
      </div>

      <div className="mrow">
        <Metrica valor={fmtInt(itens.length)} label="Ligações na fila" href="/fila" full />
      </div>

      <div className="grow" />

      <button type="button" className="cta red" onClick={sair} disabled={saindo}>
        {saindo ? "Saindo…" : "Sair da conta"}
      </button>

      <p className="dim2" style={{ textAlign: "center", fontSize: 10.5 }}>
        Central Animal · versão 2.0
      </p>
    </div>
  );
}
