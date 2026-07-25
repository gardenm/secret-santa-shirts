"use client";

import { useActionState } from "react";
import { sendMagicLink } from "../actions";

export function SignInForm() {
  const [state, action, pending] = useActionState(sendMagicLink, null);

  if (state?.ok) {
    return (
      <div className="card">
        <p className="font-medium">Check your email.</p>
        <p className="mt-2 text-sm text-ink/70">
          If that address is on the invite list, there is a sign-in link waiting for it.
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="card space-y-4">
      <div>
        <label className="label" htmlFor="email">
          Email address
        </label>
        <input id="email" name="email" type="email" required className="field" autoComplete="email" />
      </div>

      {state && !state.ok && <p className="text-sm text-cranberry">{state.error}</p>}

      <button type="submit" className="btn-primary w-full" disabled={pending}>
        {pending ? "Sending…" : "Email me a sign-in link"}
      </button>
    </form>
  );
}
