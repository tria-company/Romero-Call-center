"use client";

import { useEffect, useState } from "react";

/**
 * Registra o service worker (só em produção — em dev ele serve HTML velho e
 * confunde o desenvolvimento) e oferece a atualização quando há versão nova.
 *
 * O aviso é um botão flutuante e não um toast: não existe fila de avisos neste
 * app, e criar um sistema inteiro para uma única mensagem seria desproporcional.
 */
export function RegisterSW() {
  const [reg, setReg] = useState<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    /* DEV: não basta NÃO registrar — é preciso DESREGISTRAR.
       `npm run start` e `npm run dev` moram na mesma origem (localhost:3011),
       então um service worker instalado numa rodada de produção continua no
       comando quando se volta para o dev, servindo o shell de produção por
       cima. O HTML velho aponta para chunks `/_next/static/*` que não existem
       em dev e a tela simplesmente não carrega — sem erro no terminal, porque
       o servidor está ótimo. Já custou uma sessão. */
    if (process.env.NODE_ENV !== "production") {
      void (async () => {
        const registros = await navigator.serviceWorker.getRegistrations();
        if (registros.length === 0) return;
        await Promise.all(registros.map((r) => r.unregister()));
        if (typeof caches !== "undefined") {
          const nomes = await caches.keys();
          await Promise.all(nomes.map((n) => caches.delete(n)));
        }
        // recarrega uma vez só: no próximo carregamento não há registro, e a
        // função sai antes daqui
        if (navigator.serviceWorker.controller) window.location.reload();
      })();
      return;
    }

    let cancelado = false;

    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((r) => {
        if (cancelado) return;
        if (r.waiting) setReg(r);
        r.addEventListener("updatefound", () => {
          const novo = r.installing;
          novo?.addEventListener("statechange", () => {
            if (novo.state === "installed" && navigator.serviceWorker.controller) setReg(r);
          });
        });
      })
      .catch(() => {
        /* SW é progressivo: se falhar, o app continua funcionando online */
      });

    let recarregando = false;
    const onControllerChange = () => {
      if (recarregando) return;
      recarregando = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    return () => {
      cancelado = true;
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  if (!reg) return null;

  return (
    <button
      type="button"
      onClick={() => reg.waiting?.postMessage({ type: "SKIP_WAITING" })}
      style={{
        position: "fixed",
        left: "50%",
        transform: "translateX(-50%)",
        bottom: "calc(var(--tabbar-h) + var(--tabbar-gap) * 2 + var(--safe-b))",
        zIndex: 300,
        padding: "10px 16px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 800,
        color: "#04122a",
        background: "linear-gradient(90deg,#3d8bff,#2bb6a0)",
        boxShadow: "var(--shadow-lg)",
        animation: "toast-in 300ms var(--ease-out-soft)",
      }}
    >
      Nova versão · tocar para atualizar
    </button>
  );
}
