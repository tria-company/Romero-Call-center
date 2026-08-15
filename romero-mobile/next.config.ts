import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Nada de `typescript.ignoreBuildErrors` aqui: o app nasce com o build tipado.

  // O selo de dev do Next fica no canto inferior esquerdo — exatamente sobre a
  // primeira aba da tab bar em viewport de celular, tornando-a intocável.
  devIndicators: false,
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
