import { useState } from 'react';
import Banner from './Banner.jsx';
import { BTN_PRIMARY, HEADING, INPUT, MUTED, PANEL, SHELL_NARROW } from '../ui.js';

/**
 * Landing screen: pick a username, then either create a room or join one with
 * a code (optionally pre-filled from a ?room=CODE invite link).
 *
 * Purely presentational - App.jsx owns the state and performs the requests.
 */
export default function Home({
  initialRoomId,
  username,
  pending,
  error,
  connectionError,
  onUsernameChange,
  onCreate,
  onJoin,
}) {
  const [roomId, setRoomId] = useState(initialRoomId);
  const busy = pending !== '';

  return (
    <main className={SHELL_NARROW}>
      <header className="flex flex-col items-center gap-3 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-red-600">
          <svg viewBox="0 0 24 24" className="h-6 w-6 fill-white" aria-hidden="true">
            <path d="M9.5 7.5l7 4.5-7 4.5z" />
          </svg>
        </span>

        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">YouTube Watch Party</h1>
        <p className="max-w-md text-slate-400">
          Watch YouTube together, in sync. One person hosts the room and shares the code with
          everyone else.
        </p>
      </header>

      <Banner variant="error">{error}</Banner>
      <Banner variant="warning">{connectionError}</Banner>

      <section className={PANEL}>
        <h2 className={HEADING}>Your name</h2>
        <input
          type="text"
          value={username}
          maxLength={24}
          placeholder="e.g. Ranjan"
          disabled={busy}
          aria-label="Username"
          className={INPUT}
          onChange={(event) => onUsernameChange(event.target.value)}
        />
        <p className={MUTED}>This is how everyone else in the room will see you.</p>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <section className={PANEL} aria-busy={pending === 'create'}>
          <h2 className={HEADING}>Start a new room</h2>
          <p className={MUTED}>You become the host - you pick the video and control playback.</p>
          <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={onCreate}>
            {pending === 'create' ? 'Creating room...' : 'Create room'}
          </button>
        </section>

        <section className={PANEL} aria-busy={pending === 'join'}>
          <h2 className={HEADING}>Join an existing room</h2>
          <p className={MUTED}>Type the 6-character code the host shared with you.</p>
          <input
            type="text"
            value={roomId}
            maxLength={8}
            placeholder="ABC123"
            disabled={busy}
            aria-label="Room code"
            className={`${INPUT} tracking-[0.15em] uppercase`}
            onChange={(event) => setRoomId(event.target.value.toUpperCase())}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onJoin(roomId);
            }}
          />
          <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => onJoin(roomId)}>
            {pending === 'join' ? 'Joining room...' : 'Join room'}
          </button>
        </section>
      </div>

      <p className="text-center text-xs text-slate-500">
        Tip: to test more than one participant, open the invite link in a private window or a
        different browser - a normal second tab shares your identity.
      </p>
    </main>
  );
}



