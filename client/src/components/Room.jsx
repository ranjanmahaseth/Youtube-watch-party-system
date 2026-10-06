import { useEffect, useRef, useState } from 'react';
import Banner from './Banner.jsx';
import ChatPanel from './ChatPanel.jsx';
import VideoPanel from './VideoPanel.jsx';
import {
  BADGE,
  BTN_DANGER,
  BTN_GHOST,
  BTN_REMOVE,
  BTN_ROW,
  DOT,
  HEADING,
  LABEL,
  MUTED,
  PANEL,
  SHELL,
} from '../ui.js';

const ROLE_LABEL = {
  host: 'Host',
  moderator: 'Moderator',
  participant: 'Participant',
};

const ROLE_BADGE = {
  host: 'border-red-900 bg-red-950 text-red-300',
  moderator: 'border-sky-900 bg-sky-950 text-sky-300',
  participant: 'border-slate-700 bg-slate-800 text-slate-300',
};

const CONNECTION_LABEL = {
  idle: 'Offline',
  connecting: 'Connecting...',
  connected: 'Connected',
  disconnected: 'Reconnecting...',
};

/**
 * The room screen.
 *
 * Layout: one column on mobile; on large screens the player takes the main
 * column while identity, participants and activity sit in a sidebar.
 *
 * Every role check below is UX only. The server re-checks the role on every
 * privileged event, so hiding a control is a courtesy and never the guard.
 */
export default function Room({
  state,
  myUserId,
  activity,
  chatMessages = [],
  onSendMessage,
  connection,
  onLeave,
  onChangeVideo,
  videoError,
  remoteCommand,
  onLocalPlayback,
  onSeek,
  syncTarget,
  onRemoveParticipant,
  removingUserId,
  memberError,
  onAssignRole,
  assigningUserId,
  canGoBackVideo = false,
  onPreviousVideo,
  videoHistoryCount = 1,
  onTransferHost,
  transferringUserId = '',
}) {
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState('chat');
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const prevChatCountRef = useRef(chatMessages.length);

  // Track unread messages when on the participants tab
  useEffect(() => {
    if (activeTab !== 'chat' && chatMessages.length > prevChatCountRef.current) {
      const newMessages = chatMessages.slice(prevChatCountRef.current);
      const fromOthers = newMessages.filter((m) => m.userId !== myUserId);
      if (fromOthers.length > 0) {
        setUnreadChatCount((count) => count + fromOthers.length);
      }
    }
    prevChatCountRef.current = chatMessages.length;
  }, [chatMessages, activeTab, myUserId]);
  const me = state.participants.find((participant) => participant.userId === myUserId);
  const inviteLink = `${window.location.origin}/?room=${state.roomId}`;
  const isConnected = connection === 'connected';
  const connectionLabel = CONNECTION_LABEL[connection] ?? 'Reconnecting...';
  const myRole = me?.role ?? 'participant';
  // Convenience only: it decides whether the link box is shown. The server
  // re-checks the role before it processes change_video.
  const canControl = myRole === 'host' || myRole === 'moderator';
  // Host-only powers. A moderator may control playback but must not eject
  // anyone, nor hand out roles.
  const canManage = myRole === 'host';

  async function copyInviteLink() {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <main className={SHELL}>
      {/* Top back navigation bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {canControl && canGoBackVideo && (
            <button
              type="button"
              onClick={onPreviousVideo}
              className="group inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/40 bg-indigo-950/60 px-3.5 py-1.5 text-xs font-semibold text-indigo-200 transition hover:border-indigo-400 hover:bg-indigo-900/80 hover:text-white"
              title="Go back to previous video (or press browser Back button)"
            >
              <svg
                className="h-3.5 w-3.5 transition group-hover:-translate-x-0.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M11 19l-7-7 7-7m8 14l-7-7 7-7"
                />
              </svg>
              <span>⏮ Previous Video</span>
              <span className="rounded bg-indigo-500/25 px-1.5 py-0.2 text-[10px] font-mono text-indigo-300">
                {videoHistoryCount}
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={onLeave}
            className="group inline-flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/90 px-3.5 py-1.5 text-xs font-semibold text-slate-300 transition hover:border-slate-700 hover:bg-slate-800 hover:text-white"
            title="Go back to Home"
          >
            <svg
              className="h-3.5 w-3.5 transition group-hover:-translate-x-0.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 19l-7-7m0 0l7-7m-7 7h18"
              />
            </svg>
            <span>Back to Home</span>
          </button>
        </div>

        <span className="text-xs text-slate-500">
          Room: <span className="font-mono font-semibold text-slate-300">{state.roomId}</span>
        </span>
      </div>

      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <span className={LABEL}>Room code</span>
          <h1 className="truncate text-3xl font-bold tracking-[0.16em] sm:text-4xl">
            {state.roomId}
          </h1>
          <p className="mt-2 flex items-center gap-2 text-xs text-slate-400">
            <span className={`${DOT} ${isConnected ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            {connectionLabel}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {canControl && canGoBackVideo && (
            <button
              type="button"
              className={BTN_GHOST}
              onClick={onPreviousVideo}
              title="Go back to previous video in history"
            >
              ⏮ Previous Video
            </button>
          )}
          <button type="button" className={BTN_GHOST} onClick={copyInviteLink}>
            {copied ? 'Link copied' : 'Copy room link'}
          </button>
          <button type="button" className={BTN_DANGER} onClick={onLeave}>
            Leave room
          </button>
        </div>
      </header>

      <Banner variant="warning">
        {isConnected ? '' : `${connectionLabel} - restoring your place in the room.`}
      </Banner>

      <Banner variant="error">
        {isConnected && !me ? 'You are no longer a participant of this room.' : ''}
      </Banner>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div className="flex min-w-0 flex-col gap-5">
          <VideoPanel
            video={state.video}
            canControl={canControl}
            onChangeVideo={onChangeVideo}
            error={videoError}
            remoteCommand={remoteCommand}
            onLocalPlayback={onLocalPlayback}
            onSeek={onSeek}
            syncTarget={syncTarget}
          />

          {activity.length > 0 && (
            <section className={PANEL}>
              <h2 className={HEADING}>Activity</h2>
              <ul className="flex flex-col gap-1.5">
                {activity.map((item) => (
                  <li key={item.id} className="flex gap-2 text-sm text-slate-400">
                    <span aria-hidden="true" className="text-slate-600">
                      &bull;
                    </span>
                    <span>{item.text}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <aside className="flex min-w-0 flex-col gap-4">
          <section className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-900 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <span className={LABEL}>Signed in as</span>
                <p className="truncate font-semibold text-slate-100">{me?.username ?? '...'}</p>
              </div>
              <span className={`${BADGE} ${ROLE_BADGE[myRole]}`}>{ROLE_LABEL[myRole]}</span>
            </div>

            <p className="text-xs text-slate-400">
              {canManage
                ? 'You can change the video, control playback, manage roles and remove people.'
                : canControl
                  ? 'You can change the video and control playback.'
                  : 'You are watching along. Only the host and moderators can control playback.'}
            </p>
          </section>

          <section className="flex flex-col rounded-xl border border-slate-800 bg-slate-900 overflow-hidden shadow-sm">
            {/* Tab Navigation */}
            <div className="flex border-b border-slate-800 bg-slate-950/70">
              <button
                type="button"
                onClick={() => {
                  setActiveTab('chat');
                  setUnreadChatCount(0);
                }}
                className={`flex flex-1 items-center justify-center gap-2 py-3 px-3 text-sm font-semibold border-b-2 transition ${
                  activeTab === 'chat'
                    ? 'border-red-500 text-white bg-slate-900/60'
                    : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-900/30'
                }`}
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                  />
                </svg>
                <span>Live Chat</span>
                {unreadChatCount > 0 && (
                  <span className="rounded-full bg-red-600 px-1.5 py-0.2 text-[10px] font-bold text-white animate-pulse">
                    {unreadChatCount}
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('participants')}
                className={`flex flex-1 items-center justify-center gap-2 py-3 px-3 text-sm font-semibold border-b-2 transition ${
                  activeTab === 'participants'
                    ? 'border-red-500 text-white bg-slate-900/60'
                    : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-900/30'
                }`}
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                  />
                </svg>
                <span>Participants</span>
                <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-300">
                  {state.participants.length}
                </span>
              </button>
            </div>

            {/* Tab Panels */}
            {activeTab === 'chat' ? (
              <ChatPanel
                messages={chatMessages}
                myUserId={myUserId}
                onSendMessage={onSendMessage}
                disabled={!isConnected}
                participantCount={state.participants.length}
                onViewParticipants={() => setActiveTab('participants')}
              />
            ) : (
              <div className="flex flex-col gap-3 p-4">
                <Banner variant="error">{memberError}</Banner>

                {state.participants.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-slate-700 px-4 py-4 text-center text-sm text-slate-400">
                    No participants yet.
                  </p>
                ) : (
                  <ul className="flex max-h-104 flex-col gap-2 overflow-y-auto pr-1">
                    {state.participants.map((participant) => {
                      const isMe = participant.userId === myUserId;
                      const rowBusy =
                        removingUserId === participant.userId ||
                        assigningUserId === participant.userId;

                      return (
                        <li
                          key={participant.userId}
                          className="flex flex-col gap-2 rounded-lg bg-slate-950 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <span className="flex min-w-0 items-baseline gap-2">
                            <span className="truncate font-medium text-slate-200">
                              {participant.username}
                            </span>
                            {isMe && <span className="shrink-0 text-xs text-slate-500">you</span>}
                          </span>

                          <span className="flex shrink-0 flex-wrap items-center gap-2">
                            <span className={`${BADGE} ${ROLE_BADGE[participant.role]}`}>
                              {ROLE_LABEL[participant.role]}
                            </span>

                            {/* Host-only, and never on your own row. The server
                                refuses both cases regardless - this only keeps the
                                UI honest. */}
                            {canManage && !isMe && (
                              <>
                                {participant.role === 'participant' ? (
                                  <button
                                    type="button"
                                    className={BTN_ROW}
                                    title="Give this person playback control"
                                    disabled={rowBusy}
                                    onClick={() => onAssignRole(participant.userId, 'moderator')}
                                  >
                                    Promote
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className={BTN_ROW}
                                    title="Take playback control away"
                                    disabled={rowBusy}
                                    onClick={() => onAssignRole(participant.userId, 'participant')}
                                  >
                                    Demote
                                  </button>
                                )}

                                <button
                                  type="button"
                                  className="rounded border border-amber-600/40 bg-amber-950/40 px-2 py-1 text-xs font-semibold text-amber-300 transition hover:bg-amber-900/60 hover:text-white"
                                  title="Transfer Host role to this participant"
                                  disabled={rowBusy || transferringUserId === participant.userId}
                                  onClick={() => {
                                    if (
                                      window.confirm(
                                        `Transfer Host role to "${participant.username}"? You will become a moderator.`,
                                      )
                                    ) {
                                      onTransferHost?.(participant.userId);
                                    }
                                  }}
                                >
                                  {transferringUserId === participant.userId ? 'Transferring...' : '👑 Make Host'}
                                </button>

                                <button
                                  type="button"
                                  className={BTN_REMOVE}
                                  disabled={rowBusy}
                                  onClick={() => onRemoveParticipant(participant.userId)}
                                >
                                  {removingUserId === participant.userId ? 'Removing...' : 'Remove'}
                                </button>
                              </>
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}


