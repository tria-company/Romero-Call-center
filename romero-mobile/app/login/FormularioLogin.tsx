"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, TriangleAlert } from "lucide-react";
import { Marca } from "@/components/brand/Marca";

export function FormularioLogin() {
  const router = useRouter();
  const [usuario, setUsuario] = useState("");
  const [senha, setSenha] = useState("");
  const [verSenha, setVerSenha] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    if (enviando) return;
    setErro(null);
    setEnviando(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ usuario, senha }),
      });
      const dados = (await res.json().catch(() => ({}))) as { error?: string; nome?: string };
      if (!res.ok) {
        setErro(dados.error ?? "Não foi possível entrar.");
        setEnviando(false);
        return;
      }
      try {
        // o nome do operador vira responsável nas solicitações assumidas
        if (dados.nome) localStorage.setItem("ca.operador", dados.nome);
      } catch {
        /* armazenamento bloqueado; o nome cai no padrão */
      }
      router.replace("/");
      router.refresh();
    } catch {
      setErro("Falha de conexão. Tente de novo.");
      setEnviando(false);
    }
  }

  return (
    <div style={{ width: "100%", maxWidth: 360 }}>
      <div
        className="lblk"
        style={{
          padding: "26px 20px 22px",
          borderRadius: "var(--r-xl)",
          background: "rgba(255,255,255,.055)",
          animation: "reveal-up 520ms var(--ease-out-soft)",
        }}
      >
        <div style={{ display: "grid", placeItems: "center", textAlign: "center" }}>
          <Marca size={58} showName={false} />
          <h1 style={{ marginTop: 14, fontSize: 22, fontWeight: 800, letterSpacing: "-.03em" }}>
            Central Animal
          </h1>
          <p className="dim" style={{ marginTop: 6, fontSize: 12 }}>
            Sistema de relacionamento direto
          </p>
          <div className="row" style={{ gap: 8, marginTop: 14 }}>
            <span className="tag pe">Romero · 40000</span>
            <span className="tag t3">Andreza · 4020</span>
          </div>
        </div>

        <form onSubmit={enviar} style={{ marginTop: 22, display: "grid", gap: 12 }}>
          <div>
            <div className="flabel">E-mail</div>
            <input
              className="field"
              value={usuario}
              onChange={(e) => setUsuario(e.target.value)}
              type="text"
              inputMode="email"
              placeholder="admin@admin.com"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
            />
          </div>

          <div>
            <div className="flabel">Senha</div>
            <span style={{ position: "relative", display: "block" }}>
              <input
                className="field"
                type={verSenha ? "text" : "password"}
                value={senha}
                onChange={(e) => setSenha(e.target.value)}
                autoComplete="current-password"
                required
                style={{ paddingRight: 44 }}
              />
              <button
                type="button"
                onClick={() => setVerSenha((v) => !v)}
                aria-label={verSenha ? "Ocultar senha" : "Mostrar senha"}
                style={{
                  position: "absolute",
                  right: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "var(--dim-2)",
                  display: "inline-flex",
                }}
              >
                {verSenha ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </span>
          </div>

          {erro && (
            <div
              role="alert"
              className="autobox warn anim-scale"
              style={{ display: "flex", gap: 8, alignItems: "center" }}
            >
              <TriangleAlert size={15} style={{ color: "var(--alert)", flex: "none" }} />
              <span className="ab" style={{ marginTop: 0 }}>
                {erro}
              </span>
            </div>
          )}

          <button type="submit" className="cta" disabled={enviando} style={{ marginTop: 2 }}>
            {enviando ? "Entrando…" : "Entrar"}
          </button>
        </form>
      </div>

      <p
        className="dim2"
        style={{ textAlign: "center", marginTop: 14, fontSize: 11, animation: "fade-in 700ms 500ms backwards" }}
      >
        Acesso restrito à equipe do gabinete.
      </p>
    </div>
  );
}
