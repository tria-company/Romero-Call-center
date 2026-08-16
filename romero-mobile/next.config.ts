import type { NextConfig } from "next";

// MESMO ENDERECO (origem unica): o painel proxia o discador (backend Mastra) via
// rewrites, entao `/discador` e `/api/discador/*` vivem na MESMA origem do painel
// — mesmo localStorage/cookie, sem re-login. Default = VPS (prod); no LOCAL,
// sobrescreva com `DISCADOR_ORIGIN=http://localhost:4111`.
const DISCADOR_ORIGIN = (process.env.DISCADOR_ORIGIN || "http://85.155.178.244:4111").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  // Nada de `typescript.ignoreBuildErrors` aqui: o app nasce com o build tipado.

  // O selo de dev do Next fica no canto inferior esquerdo — exatamente sobre a
  // primeira aba da tab bar em viewport de celular, tornando-a intocável.
  devIndicators: false,
  // NAO proxiar `/api/mobile` nem `/api/auth`: sao nativas do Next (pontes do
  // painel e handoff de sessao). So o discador/admin do Mastra vao pro backend.
  async rewrites() {
    return [
      { source: "/discador", destination: `${DISCADOR_ORIGIN}/discador` },
      { source: "/discador/:path*", destination: `${DISCADOR_ORIGIN}/discador/:path*` },
      { source: "/api/discador/:path*", destination: `${DISCADOR_ORIGIN}/api/discador/:path*` },
      { source: "/admin", destination: `${DISCADOR_ORIGIN}/admin` },
      { source: "/admin/:path*", destination: `${DISCADOR_ORIGIN}/admin/:path*` },
      { source: "/api/admin/:path*", destination: `${DISCADOR_ORIGIN}/api/admin/:path*` },
    ];
  },
  async headers() {
    return [
      {
        // O service worker precisa de escopo raiz e não pode ficar preso em cache.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
