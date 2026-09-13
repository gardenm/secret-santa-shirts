import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "./nav";

/**
 * Nothing here is static, and saying so is what keeps the build honest.
 *
 * The nav renders the signed-in person's email, so every page under this
 * layout is per-user by construction. Without this, `next build` tries to
 * prerender them, reaches the session lookup, and dies on a database that is
 * not meant to be reachable at build time at all.
 */
export const dynamic = "force-dynamic";

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
