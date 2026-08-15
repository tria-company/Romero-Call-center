import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Central Animal", template: "%s · Central Animal" },
  description:
    "Sistema de relacionamento direto do gabinete: fila do dia, base de apoiadores e solicitações.",
  applicationName: "Central Animal",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    // curto de propósito: é o rótulo sob o ícone na tela de início do iPhone
    title: "Central",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  // Tema único, escuro: o mockup não tem variante clara, e a barra de status
  // do modo instalado precisa acompanhar o fundo.
  themeColor: "#04122a",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
