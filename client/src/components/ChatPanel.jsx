import { useEffect, useRef, useState } from 'react';
import { BTN_PRIMARY, INPUT } from '../ui.js';

const ROLE_BADGE = {
  host: 'border-red-900/60 bg-red-950/60 text-red-300',
  moderator: 'border-sky-900/60 bg-sky-950/60 text-sky-300',
  participant: 'border-slate-700/60 bg-slate-800/60 text-slate-400',
};

const ROLE_LABEL = {
  host: 'Host',
  moderator: 'Mod',
  participant: 'Guest',
};

function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function ChatPanel({
  messages = [],
  myUserId,
  onSendMessage,
  disabled = false,
  onViewParticipants,
  participantCount = 0,
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const messagesEndRef = useRef(null);
  const listContainerRef = useRef(null);
  const prevMessagesLengthRef = useRef(messages.length);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    const container = listContainerRef.current;
    if (!container) return;

    // Check if user was already scrolled near the bottom (within 100px)
    const isNearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 120;

    // If new message was added and user is near bottom, scroll down
    if (messages.length > prevMessagesLengthRef.current) {
      if (isNearBottom) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    }
    prevMessagesLengthRef.current = messages.length;
  }, [messages]);

  // Initial scroll to bottom on mount
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || sending || disabled) return;

    setSending(true);
    setSendError('');

    try {
      const result = await onSendMessage(trimmed);
      if (result?.ok) {
        setText('');
      } else {
        setSendError(result?.error === 'EMPTY_MESSAGE' ? 'Message cannot be empty.' : 'Could not send message.');
      }
    } catch {
      setSendError('Failed to send message. Please check connection.');
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(event) {
    // Send on Enter (unless Shift+Enter is pressed)
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSubmit(event);
    }
  }

  return (
    <div className="flex h-120 flex-col">
      {/* Subheader: participant count button */}
      {onViewParticipants && participantCount > 0 && (
        <div className="flex items-center justify-between border-b border-slate-800/80 px-4 py-2 text-xs text-slate-400">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>Party Live Chat</span>
          </span>
          <button
            type="button"
            onClick={onViewParticipants}
            className="text-xs text-slate-400 transition hover:text-slate-200 underline underline-offset-2"
          >
            {participantCount} {participantCount === 1 ? 'person' : 'people'} in room
          </button>
        </div>
      )}

      {/* Message Feed */}
      <div
        ref={listContainerRef}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5 scroll-smooth"
      >
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-slate-500 py-8">
            <svg
              className="h-10 w-10 text-slate-600 mb-2"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              />
            </svg>
            <p className="text-sm font-medium text-slate-400">No messages yet</p>
            <p className="mt-1 text-xs text-slate-500">Say hello to everyone in the party!</p>
          </div>
        ) : (
          messages.map((msg) => {
            const isMe = msg.userId === myUserId;
            return (
              <div
                key={msg.id}
                className={`flex flex-col gap-1 rounded-lg px-3 py-2 text-sm transition ${
                  isMe
                    ? 'border border-slate-700/60 bg-slate-800/40'
                    : 'border border-slate-800/60 bg-slate-950/50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-semibold text-slate-200">
                      {msg.username}
                    </span>
                    {isMe && (
                      <span className="shrink-0 text-[10px] text-slate-500 font-mono">
                        (you)
                      </span>
                    )}
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider border ${
                        ROLE_BADGE[msg.role] ?? ROLE_BADGE.participant
                      }`}
                    >
                      {ROLE_LABEL[msg.role] ?? msg.role}
                    </span>
                  </div>
                  <span className="shrink-0 text-[11px] text-slate-500">
                    {formatTime(msg.timestamp)}
                  </span>
                </div>
                <p className="wrap-break-words text-slate-300 text-sm whitespace-pre-wrap leading-relaxed">
                  {msg.text}
                </p>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input / Send Form */}
      <form
        onSubmit={handleSubmit}
        className="border-t border-slate-800/80 p-3 bg-slate-900/60 rounded-b-xl"
      >
        {sendError && (
          <p className="mb-2 text-xs text-red-400">{sendError}</p>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            className={`${INPUT} text-sm py-2`}
            placeholder={disabled ? 'Connecting...' : 'Type a message...'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            maxLength={500}
            disabled={disabled || sending}
          />
          <button
            type="submit"
            className={`${BTN_PRIMARY} px-3.5 py-2 text-sm shrink-0 flex items-center gap-1.5`}
            disabled={!text.trim() || sending || disabled}
          >
            <span>Send</span>
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M14 5l7 7m0 0l-7 7m7-7H3"
              />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}

