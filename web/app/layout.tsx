import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import type { ReactNode } from "react";
import { App } from "@/components/shell";
import { t } from "@/lib/strings";
import "./globals.css";

const sans = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = { title: t.app.name, description: t.app.description };
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id" className={sans.variable}>
      <body className="font-sans">
        <App>{children}</App>
      </body>
    </html>
  );
}
