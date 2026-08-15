"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  exportarJson,
  iniciais,
  ressemear,
  useBanco,
  useCandidatos,
  useIndicadores,
} from "@/lib/db";
import { fmtInt } from "@/lib/format";
import { operadorAtual } from "@/components/shell/BootDados";
import { InstallPrompt } from "@/components/shell/InstallPrompt";
import { Autobox, BlocoLista, Esqueleto, Metrica, Vhead } from "./blocos";
import { Folha } from "./Folha";

/* TELA · PERFIL (do operador)
   A última aba da navegação — quarta desde que a Equipe saiu. É a única que o
   mockup não desenha; foi montada com os mesmos blocos das outras, sem inventar
   componente novo. */

export function Perfil() {
  const router = useRouter();
  const banco = useBanco();
  const ind = useIndicadores();
  const candidatos = useCandidatos();

  const [nome, setNome] = React.useState("");
  const [confirmandoReset, setConfirmando] = React.useState(false);
  const [saindo, setSaindo] = React.useState(false);

  React.useEffect(() => setNome(operadorAtual()), []);

  if (!banco || !ind) return <Esqueleto alturas={[64, 76, 120, 120, 74]} />;

  function salvarNome(v: string) {
    setNome(v);
    try {
      localStorage.setItem("ca.operador", v.trim() || "Romero");
    } catch {
      /* armazenamento bloqueado; o nome vale só nesta sessão */
    }
  }

  async function baixar() {
    const json = await exportarJson();
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `central-animal-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
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
        {/* falava em "responsável nas solicitações que você assume" — assumir
            saiu junto com a tela de Equipe. O nome continua valendo: é o que
            abre o Início e o que a folha de registro grava. */}
        <p className="dim2" style={{ fontSize: 10.5, marginTop: 6, lineHeight: 1.5 }}>
          É este nome que aparece no cumprimento do Início e nos registros que você faz.
        </p>
      </div>

      <div className="mrow">
        <Metrica valor={fmtInt(ind.filaFeitas)} label="Contatos feitos hoje" />
        <Metrica valor={fmtInt(ind.filaRestante)} label="Ainda na fila" href="/fila" />
      </div>

      <BlocoLista titulo="Campanha" contador="2 urnas">
        {candidatos.map((c) => (
          <div key={c.id} className="lrow">
            <span className={c.id === "romero" ? "dot" : "dot am"} />
            <span className="nm">
              {c.nome} · {c.numero}
            </span>
            <span className="tm">
              {fmtInt(c.apoio)} / {fmtInt(c.meta)}
            </span>
          </div>
        ))}
      </BlocoLista>

      <Autobox titulo="📱 Os dados ficam neste aparelho" tom="info">
        Nada é enviado para servidor. Limpar os dados do site apaga a base local.
      </Autobox>

      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="seg" onClick={baixar}>
          Exportar JSON
        </button>
        <button type="button" className="seg" onClick={() => setConfirmando(true)}>
          Recarregar base de exemplo
        </button>
      </div>

      <div className="grow" />

      <button type="button" className="cta red" onClick={sair} disabled={saindo}>
        {saindo ? "Saindo…" : "Sair da conta"}
      </button>

      <p className="dim2" style={{ textAlign: "center", fontSize: 10.5 }}>
        Central Animal · versão 2.0
      </p>

      <Folha
        aberto={confirmandoReset}
        onFechar={() => setConfirmando(false)}
        titulo="Recarregar base de exemplo?"
        rodape={
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="cta ghost"
              style={{ flex: 1 }}
              onClick={() => setConfirmando(false)}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="cta red"
              style={{ flex: 2 }}
              onClick={async () => {
                await ressemear();
                setConfirmando(false);
              }}
            >
              Recarregar
            </button>
          </div>
        }
      >
        <p className="dim" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
          Isso apaga <b>toda</b> a base deste aparelho — pessoas, fila, linha do tempo e
          solicitações — e gera uma base nova de exemplo. Não dá para desfazer.
        </p>
      </Folha>
    </div>
  );
}
