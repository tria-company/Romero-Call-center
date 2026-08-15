import type { MetadataRoute } from "next";

/**
 * Manifest do PWA.
 *
 * Os ÍCONES são gerados em build por `app/icones/[size]` (next/og): nenhum
 * binário versionado, e o desenho acompanha os tokens da marca.
 *
 * As SCREENSHOTS são capturas de verdade do app (`public/telas/*.png`), não
 * pôsteres desenhados — é o que o Android mostra no cartão de instalação, e
 * prometer uma tela que não existe é o tipo de coisa que o usuário descobre
 * no primeiro toque.
 */
export default function manifest(): MetadataRoute.Manifest {
  // JPEG e não PNG: as três telas em PNG somavam 710 KB no repositório para
  // arte que só aparece no cartão de instalação. Em JPEG 82 dão 190 KB.
  const tela = (nome: string, label: string) => ({
    src: `/telas/${nome}.jpg`,
    sizes: "540x1170",
    type: "image/jpeg",
    form_factor: "narrow" as const,
    label,
  });

  return {
    name: "Central Animal — Gabinete",
    // short_name é o que cabe embaixo do ícone na tela de início
    short_name: "Central",
    description:
      "Fila do dia, base de apoiadores e solicitações — na palma da mão.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    // se o aparelho não suportar standalone, cai para a barra mínima em vez
    // de abrir uma aba de navegador comum
    display_override: ["standalone", "minimal-ui"],
    orientation: "portrait",
    background_color: "#04122a",
    theme_color: "#04122a",
    lang: "pt-BR",
    dir: "ltr",
    categories: ["productivity", "business"],
    prefer_related_applications: false,

    icons: [
      { src: "/icones/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icones/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icones/512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],

    screenshots: [
      tela("inicio", "Início — seguidores, base e as duas urnas"),
      tela("fila", "Fila de hoje, ordenada pelo sistema"),
      tela("perfil", "Perfil do apoiador, com pet e atendimentos"),
    ],

    shortcuts: [
      {
        name: "Fila de hoje",
        short_name: "Fila",
        url: "/fila",
        icons: [{ src: "/icones/192", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "Base",
        short_name: "Base",
        url: "/base",
        icons: [{ src: "/icones/192", sizes: "192x192", type: "image/png" }],
      },
    ],
  };
}
