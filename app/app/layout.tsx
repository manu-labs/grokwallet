import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GrokWallet approval",
  description: "Approve a GrokWallet agent to use wallets on your Privy account.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
