import Link from "next/link";

export default function NotFound() {
  return (
    <main className="space-y-4">
      <h1 className="text-2xl font-semibold">Nothing here</h1>
      <p className="text-ink/70">That page doesn&rsquo;t exist.</p>
      <Link href="/dashboard" className="btn-secondary">
        Back to dashboard
      </Link>
    </main>
  );
}
