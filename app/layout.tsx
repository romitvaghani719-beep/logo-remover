import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Logo Remover — Click to Inpaint",
  description: "Remove logos and watermarks with AI inpainting (LaMa)",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
