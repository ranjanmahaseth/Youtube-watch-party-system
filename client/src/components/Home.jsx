import { useState } from 'react';
import Banner from './Banner.jsx';
import { BTN_GHOST, BTN_PRIMARY, HEADING, INPUT, MUTED, PANEL, SHELL_NARROW } from '../ui.js';

/**
 * Landing screen: Authenticate (Login / Sign Up), then create a room or join
 * an existing room with a room code.
 */
export default function Home({
  initialRoomId,
  currentUser,
  pending,
  error,
  connectionError,
  authError,
  authPending,
  onLogin,
  onRegister,
  onLogout,
  onCreate,
  onJoin,
}) {
  const [roomId, setRoomId] = useState(initialRoomId);
  const [authMode, setAuthMode] = useState('login'); // 'login' | 'register'
  const [authUsername, setAuthUsername] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authEmail, setAuthEmail] = useState('');
  const [localAuthError, setLocalAuthError] = useState('');

  const busy = pending !== '';
  const isAuthBusy = authPending !== '';

  async function handleAuthSubmit(e) {
    e.preventDefault();
    setLocalAuthError('');

    const u = authUsername.trim();
    const p = authPassword;
    if (!u) {
      setLocalAuthError('Please enter a username.');
      return;
    }
    if (!p) {
      setLocalAuthError('Please enter a password.');
      return;
    }

    if (authMode === 'register') {
      if (u.length < 3) {
        setLocalAuthError('Username must be at least 3 characters long.');
        return;
      }
      if (p.length < 4) {
        setLocalAuthError('Password must be at least 4 characters long.');
        return;
      }
      try {
        await onRegister(u, p, authEmail.trim());
        setAuthPassword('');
      } catch (err) {
        setLocalAuthError(err.message || 'Registration failed.');
      }
    } else {
      try {
        await onLogin(u, p);
        setAuthPassword('');
      } catch (err) {
        setLocalAuthError(err.message || 'Login failed.');
      }
    }
  }

  return (
    <main className={SHELL_NARROW}>
      <header className="flex flex-col items-center gap-3 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-red-600 shadow-lg shadow-red-950/40">
          <svg viewBox="0 0 24 24" className="h-6 w-6 fill-white" aria-hidden="true">
            <path d="M9.5 7.5l7 4.5-7 4.5z" />
          </svg>
        </span>

        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl text-slate-100">
          YouTube Watch Party
        </h1>
        <p className="max-w-md text-slate-400">
          Watch YouTube together with friends in real-time sync. Host rooms, switch videos, and chat live.
        </p>
      </header>

      <Banner variant="error">{error}</Banner>
      <Banner variant="warning">{connectionError}</Banner>

      {/* User Status / Login / Sign-Up Section */}
      {currentUser ? (
        <section className={`${PANEL} flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-slate-800 bg-slate-900/90`}>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-500/20 font-bold text-red-400 border border-red-500/30">
              {currentUser.username?.[0]?.toUpperCase() ?? 'U'}
            </div>
            <div className="min-w-0">
              <span className="text-xs text-slate-400">Signed in as</span>
              <p className="truncate text-base font-semibold text-slate-100">
                {currentUser.username}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="rounded-lg border border-slate-700 bg-slate-800/80 px-3.5 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-slate-700 hover:text-white"
            onClick={onLogout}
          >
            Log out
          </button>
        </section>
      ) : (
        <section className={`${PANEL} border-slate-800 bg-slate-900/95`}>
          {/* Tab Selector */}
          <div className="flex rounded-lg border border-slate-800 bg-slate-950/80 p-1 mb-4">
            <button
              type="button"
              className={`flex-1 rounded-md py-1.5 text-xs font-semibold transition ${
                authMode === 'login'
                  ? 'bg-red-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              onClick={() => {
                setAuthMode('login');
                setLocalAuthError('');
              }}
            >
              Log In
            </button>
            <button
              type="button"
              className={`flex-1 rounded-md py-1.5 text-xs font-semibold transition ${
                authMode === 'register'
                  ? 'bg-red-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              onClick={() => {
                setAuthMode('register');
                setLocalAuthError('');
              }}
            >
              Sign Up
            </button>
          </div>

          <h2 className={HEADING}>
            {authMode === 'login' ? 'Sign in to join or host' : 'Create an account'}
          </h2>
          <p className={MUTED}>
            {authMode === 'login'
              ? 'Enter your credentials to access watch party rooms.'
              : 'Create a quick profile so your party friends can recognize you.'}
          </p>

          <Banner variant="error">{localAuthError || authError}</Banner>

          <form onSubmit={handleAuthSubmit} className="mt-4 flex flex-col gap-3">
            <div>
              <label className="text-xs font-medium text-slate-300 mb-1 block">Username</label>
              <input
                type="text"
                value={authUsername}
                maxLength={24}
                placeholder="e.g. Ranjan"
                disabled={isAuthBusy}
                autoComplete="username"
                className={INPUT}
                onChange={(e) => setAuthUsername(e.target.value)}
              />
            </div>

            {authMode === 'register' && (
              <div>
                <label className="text-xs font-medium text-slate-300 mb-1 block">
                  Email <span className="text-slate-500 font-normal">(optional)</span>
                </label>
                <input
                  type="email"
                  value={authEmail}
                  placeholder="e.g. you@example.com"
                  disabled={isAuthBusy}
                  autoComplete="email"
                  className={INPUT}
                  onChange={(e) => setAuthEmail(e.target.value)}
                />
              </div>
            )}

            <div>
              <label className="text-xs font-medium text-slate-300 mb-1 block">Password</label>
              <input
                type="password"
                value={authPassword}
                placeholder="••••••••"
                disabled={isAuthBusy}
                autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                className={INPUT}
                onChange={(e) => setAuthPassword(e.target.value)}
              />
            </div>

            <button
              type="submit"
              className={`${BTN_PRIMARY} mt-2 w-full justify-center`}
              disabled={isAuthBusy}
            >
              {isAuthBusy
                ? 'Processing...'
                : authMode === 'login'
                  ? 'Sign In'
                  : 'Create Account'}
            </button>
          </form>
        </section>
      )}

      {/* Room Actions */}
      <div className="grid gap-4 sm:grid-cols-2">
        <section
          className={`${PANEL} ${!currentUser ? 'opacity-60' : ''}`}
          aria-busy={pending === 'create'}
        >
          <h2 className={HEADING}>Start a new room</h2>
          <p className={MUTED}>You become the host - you pick the video, control playback, or pass host role.</p>
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={busy || !currentUser}
            onClick={onCreate}
            title={!currentUser ? 'Please log in first' : 'Create room'}
          >
            {pending === 'create' ? 'Creating room...' : 'Create room'}
          </button>
          {!currentUser && (
            <p className="mt-2 text-xs text-amber-400/90">Please sign in above to create a room.</p>
          )}
        </section>

        <section
          className={`${PANEL} ${!currentUser ? 'opacity-60' : ''}`}
          aria-busy={pending === 'join'}
        >
          <h2 className={HEADING}>Join an existing room</h2>
          <p className={MUTED}>Type the 6-character code the host shared with you.</p>
          <input
            type="text"
            value={roomId}
            maxLength={8}
            placeholder="ABC123"
            disabled={busy || !currentUser}
            aria-label="Room code"
            className={`${INPUT} tracking-[0.15em] uppercase`}
            onChange={(event) => setRoomId(event.target.value.toUpperCase())}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && currentUser) onJoin(roomId);
            }}
          />
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={busy || !currentUser}
            onClick={() => onJoin(roomId)}
            title={!currentUser ? 'Please log in first' : 'Join room'}
          >
            {pending === 'join' ? 'Joining room...' : 'Join room'}
          </button>
          {!currentUser && (
            <p className="mt-2 text-xs text-amber-400/90">Please sign in above to join a room.</p>
          )}
        </section>
      </div>

      <p className="text-center text-xs text-slate-500">
        Tip: To test with multiple participants, open an incognito/private browser tab or a different browser.
      </p>
    </main>
  );
}
