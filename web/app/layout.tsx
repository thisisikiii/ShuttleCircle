import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Sora } from "next/font/google";
import type { ReactNode } from "react";
import { App } from "@/components/shell";
import { t } from "@/lib/strings";
import "./globals.css";

const sans = Inter({ subsets: ["latin"], variable: "--font-inter" });
const display = Sora({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-sora" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-jetbrains" });

export const metadata: Metadata = { title: t.app.name, description: t.app.description };
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id" className={`${sans.variable} ${display.variable} ${mono.variable}`}>
      <body className="font-sans">
        <App>{children}</App>
      </body>
    </html>
  );
}
