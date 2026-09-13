import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "./nav";

export const metadata: Metadata = {
  title: "Secret Santa Shirts",
  description: "Everyone designs a t-shirt for someone else.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="mx-auto max-w-3xl px-4 py-10">
          <Nav />
          {children}
        </div>
      </body>
    </html>
  );
}
