import { SignInForm } from "./form";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>;
}) {
  const { sent } = await searchParams;

  return (
    <main className="mx-auto max-w-md space-y-6">
      <h1 className="text-2xl font-semibold">Sign in</h1>

      {sent ? (
        <div className="card">
          <p className="font-medium">Check your email.</p>
          <p className="mt-2 text-sm text-ink/70">
            If that address is on the invite list, there is a sign-in link waiting for it. The link
            works once and expires in 24 hours.
          </p>
        </div>
      ) : (
        <>
          <p className="text-ink/70">
            No password needed — we&rsquo;ll email you a link. Use the address you were invited on.
          </p>
          <SignInForm />
        </>
      )}
    </main>
  );
}
