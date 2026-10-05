import { useEffect, useRef, useState } from 'react';
import YouTubePlayer from './YouTubePlayer.jsx';
import Banner from './Banner.jsx';
import { buildWatchUrl, extractVideoId, PLAYER_STATE } from '../lib/youtube.js';
import { searchYouTube } from '../api.js';
import {
  clearSearchHistory,
  getSearchHistory,
  removeSearchHistoryItem,
  saveSearchHistory,
} from '../lib/searchHistory.js';
import { BTN_GHOST, BTN_PRIMARY, HEADING, INPUT, LABEL, MUTED, PANEL } from '../ui.js';

/**
 * How long we keep ignoring our own player state changes after applying a
 * command from the server. The flag normally clears the moment the player
 * reaches the state we asked for; this is only a safety net for when the player
 * never changes (for example it was already in that state).
 */
const REMOTE_SUPPRESS_MS = 2000;

/**
 * Seeking needs its own tuning, because the IFrame API gives us no way to ask
 * "did the user just move the scrubber?". See the drift detector below.
 *
 * SEEK_POLL_MS       how often we compare the player's position against where it
 *                    should be. Often enough to notice a scrub, cheap enough to
 *                    be free.
 * SEEK_DRIFT_SECONDS how far off we must be before it counts as a seek. Set well
 *                    above normal playback jitter.
 * SEEK_DEBOUNCE_MS   how long the player must be still before we report. This is
 *                    what collapses a drag into a single event.
 * SEEK_QUIET_MS      how long to ignore our own detector after applying a seek
 *                    that came from the server.
 */
const SEEK_POLL_MS = 400;
const SEEK_DRIFT_SECONDS = 1.5;
const SEEK_DEBOUNCE_MS = 300;
const SEEK_QUIET_MS = 2000;

const STATE_LABEL = {
  [PLAYER_STATE.UNSTARTED]: 'unstarted',
  [PLAYER_STATE.ENDED]: 'ended',
  [PLAYER_STATE.PLAYING]: 'playing',
  [PLAYER_STATE.PAUSED]: 'paused',
  [PLAYER_STATE.BUFFERING]: 'buffering',
  [PLAYER_STATE.CUED]: 'cued',
};

/**
 * Everything video-related for the room: the player, the link box for
 * hosts/moderators, and the playback controls.
 *
 * Three things converge here:
 *  - reporting local actions to the server   (handlePlayerStateChange)
 *  - applying commands the server sends      (remoteCommand)
 *  - applying the room's snapshot on join    (syncTarget)
 *
 * `canControl` only decides what the UI offers. It is never the guard - the
 * server re-checks the role on every play, pause, seek and change_video event.
 */
export default function VideoPanel({
  video,
  canControl,
  onChangeVideo,
  error,
  remoteCommand,
  onLocalPlayback,
  onSeek,
  syncTarget,
}) {
  const playerRef = useRef(null);

  // Loop-prevention state. `remoteExpectedRef` records the state we are
  // currently applying on behalf of the server, so the onStateChange that
  // follows is not reported back up as a fresh local action.
  const remoteExpectedRef = useRef(null);
  const suppressTimerRef = useRef(null);
  const lastStateRef = useRef(null);

  // Seek-detection state. See the drift detector further down.
  const lastTickRef = useRef({ time: 0, at: Date.now() });
  const seekQuietUntilRef = useRef(0);
  const seekDebounceRef = useRef(null);

  // Room-sync state: which video the player is currently holding, and the last
  // join snapshot that was applied, so the same one is never applied twice.
  const loadedVideoIdRef = useRef(null);
  const appliedSyncRef = useRef(null);

  const [query, setQuery] = useState('');
  const [urlError, setUrlError] = useState('');
  const [readout, setReadout] = useState('');
  const [ready, setReady] = useState(false);
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [lastSearchTerm, setLastSearchTerm] = useState('');
  const [searchHistory, setSearchHistory] = useState(() => getSearchHistory());
  const [showHistory, setShowHistory] = useState(false);
  const searchContainerRef = useRef(null);

  const videoId = video?.videoId ?? null;

  // Dismiss search history dropdown when clicking outside
  useEffect(() => {
    function handlePointerDown(event) {
      if (searchContainerRef.current && !searchContainerRef.current.contains(event.target)) {
        setShowHistory(false);
      }
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, []);

  // Keep the newest onSeek reachable from the polling effect below without
  // making that effect re-subscribe on every render.
  const onSeekRef = useRef(onSeek);
  useEffect(() => {
    onSeekRef.current = onSeek;
  });

  // Clear the timers if this panel goes away mid-command.
  useEffect(
    () => () => {
      clearTimeout(suppressTimerRef.current);
      clearTimeout(seekDebounceRef.current);
    },
    [],
  );

  /**
   * Arms both loop guards immediately before we move the player on the server's
   * behalf. While active the resulting onStateChange is not reported, and the
   * seek detector keeps refreshing its baseline instead of firing. This is the
   * only place either guard is set.
   */
  function armRemoteGuards(expectedPlayState, expectedTime) {
    const player = playerRef.current;

    seekQuietUntilRef.current = Date.now() + SEEK_QUIET_MS;
    lastTickRef.current = {
      time: typeof expectedTime === 'number' ? expectedTime : (player?.getCurrentTime() ?? 0),
      at: Date.now(),
    };

    if (!expectedPlayState) return;

    remoteExpectedRef.current = expectedPlayState;
    clearTimeout(suppressTimerRef.current);
    suppressTimerRef.current = setTimeout(() => {
      remoteExpectedRef.current = null;
    }, REMOTE_SUPPRESS_MS);
  }

  function applyRemotePlayback(type) {
    const player = playerRef.current;
    if (!player) return;

    armRemoteGuards(type, player.getCurrentTime());

    if (type === 'play') player.play();
    else player.pause();
  }

  // App forwards every command that arrives from the server through this prop,
  // tagged with an incrementing nonce, so two identical commands in a row still
  // register. This runs only for a new command, never for a re-render.
  useEffect(() => {
    if (!remoteCommand) return;

    if (remoteCommand.type === 'seek') applyRemoteSeek(remoteCommand.time);
    else applyRemotePlayback(remoteCommand.type);
  }, [remoteCommand]);

  /**
   * Applies a seek that came from the server.
   *
   * Two things are recorded so the drift detector does not read this as a local
   * seek: the position baseline moves to the target, and the detector is muted
   * for a short window while the player catches up.
   */
  function applyRemoteSeek(time) {
    const player = playerRef.current;
    if (!player || typeof time !== 'number') return;

    // A seek can re-fire onStateChange too, so arm both guards: state the state
    // we expect to end up in, and move the drift baseline to the target.
    const expected = player.getPlayerState() === PLAYER_STATE.PLAYING ? 'play' : 'pause';
    armRemoteGuards(expected, time);

    player.seekTo(time, true);
  }

  function scheduleSeekReport(time) {
    clearTimeout(seekDebounceRef.current);
    seekDebounceRef.current = setTimeout(() => onSeekRef.current(time), SEEK_DEBOUNCE_MS);
  }

  /**
   * Makes the player match the room.
   *
   * This is the new-user synchronisation: load the room's video, move to the
   * room's position, adopt the room's play state.
   *
   * It is a single effect rather than two because the order is load-bearing - a
   * seek issued before the video is cued is silently dropped - so the position is
   * handed to the load call itself.
   *
   * `status` is in the dependency list deliberately. A join snapshot almost
   * always arrives before the YouTube player has finished booting; this effect
   * then runs, does nothing, and runs again the moment `status` becomes 'ready'.
   * That IS the readiness handling.
   */
  useEffect(() => {
    if (!ready) return;

    const player = playerRef.current;
    if (!player || !videoId) return; // no video in the room yet: nothing to apply

    const videoChanged = loadedVideoIdRef.current !== videoId;
    const sync =
      syncTarget && syncTarget.videoId === videoId && appliedSyncRef.current !== syncTarget.nonce
        ? syncTarget
        : null;

    if (!videoChanged && !sync) return;

    armRemoteGuards(sync?.playState ?? null, sync?.currentTime);

    if (videoChanged) {
      loadedVideoIdRef.current = videoId;
      const shouldAutoPlay = sync ? sync.playState === 'playing' : true;
      player.loadVideo(videoId, sync?.currentTime ?? 0, shouldAutoPlay);
    } else if (sync && sync.currentTime > 0) {
      player.seekTo(sync.currentTime, true);
    }

    if (!sync) return;

    appliedSyncRef.current = sync.nonce;
    if (sync.playState === 'playing') {
      player.play();
    } else {
      player.pause();
    }
  }, [videoId, syncTarget, ready]);

  /**
   * The seek detector.
   *
   * The IFrame API has no "the user moved the scrubber" event, so a seek is
   * detected by comparing where the player actually is against where it would be
   * if it had simply kept playing. That comparison is only the trigger - the
   * emit itself is debounced, which is what turns a drag (a stream of position
   * changes) into a single message.
   */
  useEffect(() => {
    if (!canControl || !ready) return undefined;

    const player = playerRef.current;
    if (player) lastTickRef.current = { time: player.getCurrentTime(), at: Date.now() };

    const interval = setInterval(() => {
      const activePlayer = playerRef.current;
      if (!activePlayer) return;

      const now = Date.now();
      const state = activePlayer.getPlayerState();
      const actual = activePlayer.getCurrentTime();

      // Only a playing or paused player has a meaningful position.
      if (state !== PLAYER_STATE.PLAYING && state !== PLAYER_STATE.PAUSED) {
        lastTickRef.current = { time: actual, at: now };
        return;
      }

      // Just after a remote seek the player may still be catching up. Refresh
      // the baseline without treating the gap as a local seek.
      if (now < seekQuietUntilRef.current) {
        lastTickRef.current = { time: actual, at: now };
        return;
      }

      const last = lastTickRef.current;
      const rate = activePlayer.getPlaybackRate?.() ?? 1;
      const expected = last.time + ((now - last.at) / 1000) * rate;

      lastTickRef.current = { time: actual, at: now };

      if (Math.abs(actual - expected) > SEEK_DRIFT_SECONDS) scheduleSeekReport(actual);
    }, SEEK_POLL_MS);

    return () => clearInterval(interval);
  }, [canControl, ready]);

  /**
   * The ONLY place that reports playback to the server.
   *
   * Both loop guards meet here. The server broadcasts with `socket.to(room)`, so
   * the sender never receives its own event back. And a client applying a remote
   * command has `remoteExpectedRef` set, so it does not report the change it was
   * just told to make. Neither guard alone would be enough.
   */
  function handlePlayerStateChange(state) {
    const previous = lastStateRef.current;
    lastStateRef.current = state;

    if (state === previous) return; // YouTube repeats notifications; ignore them

    if (remoteExpectedRef.current) {
      const caughtUp =
        (remoteExpectedRef.current === 'play' && state === PLAYER_STATE.PLAYING) ||
        (remoteExpectedRef.current === 'pause' && state === PLAYER_STATE.PAUSED);

      if (caughtUp) {
        remoteExpectedRef.current = null;
        clearTimeout(suppressTimerRef.current);
      }

      return; // never echo a change the server asked for
    }

    if (!canControl) return; // participants never drive the room

    // Report where we are as well as what happened, so the server's stored
    // position matches the real player instead of drifting from a projection.
    const time = playerRef.current?.getCurrentTime() ?? 0;

    if (state === PLAYER_STATE.PLAYING) onLocalPlayback('play', time);
    else if (state === PLAYER_STATE.PAUSED) onLocalPlayback('pause', time);
  }

  async function performSearch(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return;

    setShowHistory(false);

    // Direct link or bare 11-char ID check
    const directId = extractVideoId(trimmed);
    if (directId) {
      setUrlError('');
      setSearchResults(null);
      setQuery('');
      onChangeVideo(directId);
      return;
    }

    // Save search term to localStorage history
    const updatedHistory = saveSearchHistory(trimmed);
    setSearchHistory(updatedHistory);

    setSearching(true);
    setUrlError('');
    setLastSearchTerm(trimmed);

    try {
      const results = await searchYouTube(trimmed);
      setSearchResults(results);
    } catch (err) {
      setUrlError(err.message || 'Failed to search YouTube videos.');
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }

  function handleSelectHistory(term) {
    setQuery(term);
    setShowHistory(false);
    performSearch(term);
  }

  function handleRemoveHistoryItem(term) {
    const updated = removeSearchHistoryItem(term);
    setSearchHistory(updated);
  }

  function handleClearAllHistory() {
    clearSearchHistory();
    setSearchHistory([]);
    setShowHistory(false);
  }

  function handleSubmit(event) {
    event.preventDefault();
    performSearch(query);
  }

  function handleSelectVideo(selectedId) {
    setUrlError('');
    setSearchResults(null);
    setQuery('');
    onChangeVideo(selectedId);
  }

  function seekBy(seconds) {
    const player = playerRef.current;
    if (!player) return;

    player.seekTo(player.getCurrentTime() + seconds);
  }

  function reportStatus() {
    const player = playerRef.current;
    if (!player) return;

    const state = player.getPlayerState();
    setReadout(
      `getCurrentTime() = ${player.getCurrentTime().toFixed(2)}s  ·  getPlayerState() = ${
        STATE_LABEL[state] ?? state
      }`,
    );
  }

  const matchingHistory = query.trim()
    ? searchHistory.filter((item) =>
        item.toLowerCase().includes(query.trim().toLowerCase())
      )
    : searchHistory.slice(0, 8);

  return (
    <section className={PANEL}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className={HEADING}>Watch together</h2>
        <div className="flex items-center gap-2">
          {ready && (
            <button
              type="button"
              onClick={() => playerRef.current?.toggleFullscreen?.()}
              className="flex items-center gap-1.5 rounded-md bg-slate-800/80 px-2.5 py-1 text-xs font-medium text-slate-300 transition hover:bg-slate-700 hover:text-white"
              title="Toggle Fullscreen"
            >
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0-4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              </svg>
              <span>Fullscreen</span>
            </button>
          )}
          <span className="text-xs text-slate-400">
            {video?.loadedBy ? `loaded by ${video.loadedBy}` : 'no video yet'}
            {videoId && (
              <a
                href={buildWatchUrl(videoId)}
                target="_blank"
                rel="noreferrer"
                className="ml-2 underline hover:text-slate-200"
              >
                open on YouTube
              </a>
            )}
          </span>
        </div>
      </div>

      <YouTubePlayer
        ref={playerRef}
        lockControls={!canControl}
        onReady={() => setReady(true)}
        onStateChange={handlePlayerStateChange}
      />

      {canControl ? (
        <div className="flex flex-col gap-2">
          <form className="flex gap-2" onSubmit={handleSubmit}>
            <div ref={searchContainerRef} className="relative flex-1">
              <input
                type="text"
                value={query}
                placeholder="Search YouTube or paste video link..."
                aria-label="Search YouTube or video link"
                className={`${INPUT} pl-9`}
                onFocus={() => setShowHistory(true)}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setShowHistory(true);
                  if (urlError) setUrlError('');
                }}
              />
              <svg
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    setSearchResults(null);
                    setUrlError('');
                    setShowHistory(false);
                  }}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-xs text-slate-400 hover:text-slate-100"
                  title="Clear input"
                >
                  ✕
                </button>
              )}

              {/* Related Search History Dropdown */}
              {showHistory && matchingHistory.length > 0 && (
                <div className="absolute left-0 right-0 top-full z-40 mt-1.5 overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl backdrop-blur-md">
                  <div className="flex items-center justify-between border-b border-slate-800/80 bg-slate-950/60 px-3 py-1.5 text-[11px] text-slate-400">
                    <span className="flex items-center gap-1.5 font-medium">
                      <svg
                        className="h-3.5 w-3.5 text-slate-500"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                      </svg>
                      <span>{query.trim() ? 'Related search history' : 'Recent searches'}</span>
                    </span>
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleClearAllHistory();
                      }}
                      className="text-[10px] text-slate-400 transition hover:text-red-400"
                    >
                      Clear all
                    </button>
                  </div>

                  <ul className="max-h-56 overflow-y-auto py-1">
                    {matchingHistory.map((item) => (
                      <li
                        key={item}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          handleSelectHistory(item);
                        }}
                        className="group flex cursor-pointer items-center justify-between px-3 py-2 text-xs text-slate-300 transition hover:bg-slate-800/80 hover:text-white"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <svg
                            className="h-3.5 w-3.5 shrink-0 text-slate-500 group-hover:text-slate-300"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                            />
                          </svg>
                          <span className="truncate font-medium">{item}</span>
                        </div>

                        <button
                          type="button"
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            handleRemoveHistoryItem(item);
                          }}
                          className="rounded p-1 text-slate-500 hover:bg-slate-700 hover:text-slate-200"
                          title="Remove from history"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={!query.trim() || searching}
              className={`${BTN_PRIMARY} shrink-0 flex items-center gap-1.5`}
            >
              {searching ? (
                <>
                  <span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  <span>Searching...</span>
                </>
              ) : (
                <>
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <span>Search / Play</span>
                </>
              )}
            </button>
          </form>

          {/* Search Results Display */}
          {searchResults !== null && (
            <div className="flex flex-col gap-2 rounded-xl border border-slate-700/80 bg-slate-950 p-3.5 shadow-xl">
              <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                <span className="text-xs font-semibold text-slate-300">
                  {searching ? (
                    <span>Searching YouTube for &ldquo;{lastSearchTerm}&rdquo;...</span>
                  ) : (
                    <span>
                      Search results for &ldquo;{lastSearchTerm}&rdquo; ({searchResults.length}{' '}
                      {searchResults.length === 1 ? 'video' : 'videos'})
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => setSearchResults(null)}
                  className="flex items-center gap-1 rounded bg-slate-800/80 px-2.5 py-1 text-xs font-medium text-slate-300 transition hover:bg-slate-700 hover:text-white"
                  title="Close search and return to player"
                >
                  <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                  </svg>
                  <span>Back to Player</span>
                </button>
              </div>

              {searching ? (
                <div className="flex items-center justify-center py-8 text-sm text-slate-400">
                  <span className="mr-2 inline-block h-4 w-4 rounded-full border-2 border-red-500 border-t-transparent animate-spin" />
                  Searching YouTube videos...
                </div>
              ) : searchResults.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-400">
                  No videos found. Try different keywords or paste a direct YouTube link.
                </p>
              ) : (
                <div className="flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
                  {searchResults.map((item) => (
                    <div
                      key={item.id}
                      onClick={() => handleSelectVideo(item.id)}
                      className="group flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/60 p-2 transition hover:border-red-500/50 hover:bg-slate-800/60"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        {/* Thumbnail */}
                        <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded bg-slate-950 sm:w-28">
                          <img
                            src={item.thumbnail}
                            alt={item.title}
                            className="h-full w-full object-cover transition duration-150 group-hover:scale-105"
                            loading="lazy"
                          />
                          {item.duration && (
                            <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 py-0.5 text-[9px] font-semibold text-slate-200">
                              {item.duration}
                            </span>
                          )}
                        </div>

                        {/* Metadata */}
                        <div className="min-w-0 flex-1">
                          <h4
                            className="line-clamp-2 text-xs sm:text-sm font-semibold text-slate-100 group-hover:text-red-400 transition"
                            title={item.title}
                          >
                            {item.title}
                          </h4>
                          <p className="mt-0.5 truncate text-[11px] text-slate-400">{item.channel}</p>
                          {item.views && (
                            <p className="text-[10px] text-slate-500">{item.views}</p>
                          )}
                        </div>
                      </div>

                      {/* Play Button */}
                      <div className="shrink-0">
                        <button
                          type="button"
                          className="flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white shadow transition group-hover:bg-red-500"
                        >
                          <svg className="h-3 w-3 fill-current" viewBox="0 0 24 24">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                          <span className="hidden sm:inline">Play</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <p className={MUTED}>
          {videoId
            ? 'Only the host or a moderator can change the video or control playback.'
            : 'Waiting for the host to pick a video.'}
        </p>
      )}

      <Banner variant="error">{urlError || error}</Banner>

      {canControl && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <span className={LABEL}>Playback - synced to everyone</span>
            <div className="flex flex-wrap gap-2">
              {/* These only move our own player. The state change that follows is
                  what gets reported, so there is a single outbound code path and
                  YouTube's own controls behave exactly the same way. */}
              <button
                type="button"
                className={BTN_PRIMARY}
                disabled={!ready}
                onClick={() => playerRef.current?.play()}
              >
                Play for everyone
              </button>
              <button
                type="button"
                className={BTN_GHOST}
                disabled={!ready}
                onClick={() => playerRef.current?.pause()}
              >
                Pause for everyone
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className={LABEL}>Seek - synced to everyone (the video's own bar works too)</span>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={BTN_GHOST} disabled={!ready} onClick={() => seekBy(-10)}>
                seekTo(-10s)
              </button>
              <button type="button" className={BTN_GHOST} disabled={!ready} onClick={() => seekBy(10)}>
                seekTo(+10s)
              </button>
              <button type="button" className={BTN_GHOST} disabled={!ready} onClick={reportStatus}>
                getCurrentTime() / getPlayerState()
              </button>
            </div>
            {readout && <p className={MUTED}>{readout}</p>}
          </div>
        </div>
      )}
    </section>
  );
}
