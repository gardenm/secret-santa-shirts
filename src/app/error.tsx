"use client";

import Link from "next/link";

/**
 * The last line of defence against a white "Application error" page.
 *
 * Next strips error messages in production, so anything thrown by a server
 * component arrives here with nothing useful in it. That is fine for a genuine
 * bug, but it was also what someone saw when their session simply expired -
 * see requirePageSession, which now redirects instead.
 */
export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="space-y-4">
      <h1 className="text-2xl font-semibold">That didn&rsquo;t work</h1>
      <p className="text-ink/70">
        Something went wrong at our end. Your design is autosaved as you work, so it should still be
        there.
      </p>
      <div className="flex flex-wrap gap-3">
        <button onClick={reset} className="btn-primary">
          Try again
        </button>
        <Link href="/dashboard" className="btn-secondary">
          Back to dashboard
        </Link>
      </div>
    </main>
  );
}
