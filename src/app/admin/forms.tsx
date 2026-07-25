"use client";

import { useActionState } from "react";
import { addExclusion, drawNames, extendDeadline, invitepeople } from "../actions";

type Person = { id: string; displayName: string };

function Status({ state }: { state: { ok: boolean; error?: string } | null }) {
  if (!state) return null;
  return state.ok ? (
    <p className="text-sm text-pine">Done.</p>
  ) : (
    <p className="text-sm text-cranberry">{state.error}</p>
  );
}

export function AdminForms({
  people,
  alreadyDrawn,
  missingCount,
  deadline,
}: {
  people: Person[];
  alreadyDrawn: boolean;
  missingCount: number;
  deadline: string;
}) {
  const [inviteState, inviteAction, inviting] = useActionState(invitepeople, null);
  const [drawState, drawAction, drawing] = useActionState(drawNames, null);
  const [exclusionState, exclusionAction, excluding] = useActionState(addExclusion, null);
  const [deadlineState, deadlineAction, savingDeadline] = useActionState(extendDeadline, null);

  return (
    <>
      <section className="card space-y-3">
        <h2 className="font-medium">Invite people</h2>
        <p className="text-sm text-ink/70">
          Only these addresses can sign in — the invite list is what keeps the exchange private.
        </p>
        <form action={inviteAction} className="space-y-3">
          <textarea
            name="emails"
            rows={3}
            className="field"
            placeholder="alex@example.com, bailey@example.com"
            required
          />
          <button className="btn-primary" disabled={inviting}>
            {inviting ? "Adding…" : "Add invites"}
          </button>
          <Status state={inviteState} />
        </form>
      </section>

      {!alreadyDrawn && people.length >= 2 && (
        <section className="card space-y-3">
          <h2 className="font-medium">Keep two people apart</h2>
          <p className="text-sm text-ink/70">
            Couples or housemates who shouldn&rsquo;t be matched with each other.
          </p>
          <form action={exclusionAction} className="flex flex-wrap items-end gap-3">
            <select name="participantA" className="field w-auto">
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
            <select name="participantB" className="field w-auto">
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
            <button className="btn-secondary" disabled={excluding}>
              Add
            </button>
          </form>
          <Status state={exclusionState} />
        </section>
      )}

      {!alreadyDrawn && (
        <section className="card space-y-3">
          <h2 className="font-medium">Run the draw</h2>
          <p className="text-sm text-ink/70">
            Everyone finds out who they&rsquo;re designing for, and shirt choices lock. This
            can&rsquo;t be undone or repeated.
          </p>
          <form action={drawAction} className="space-y-3">
            {missingCount > 0 && (
              <label className="flex items-start gap-2 rounded-lg bg-cranberry/5 p-3 text-sm">
                <input type="checkbox" name="allowIncomplete" className="mt-1" />
                <span>
                  {missingCount} {missingCount === 1 ? "person hasn't" : "people haven't"} picked a
                  shirt. Draw anyway — their designer will have nothing to work from until they do.
                </span>
              </label>
            )}
            <button className="btn-primary" disabled={drawing}>
              {drawing ? "Drawing…" : "Draw names"}
            </button>
            <Status state={drawState} />
          </form>
        </section>
      )}

      <section className="card space-y-3">
        <h2 className="font-medium">Deadline</h2>
        <form action={deadlineAction} className="flex flex-wrap items-end gap-3">
          <input type="date" name="deadline" defaultValue={deadline} className="field w-auto" />
          <button className="btn-secondary" disabled={savingDeadline}>
            Update
          </button>
        </form>
        <Status state={deadlineState} />
      </section>
    </>
  );
}
