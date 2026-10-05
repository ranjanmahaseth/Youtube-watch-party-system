import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { loadYouTubeApi } from '../lib/youtubeApi.js';
import { PLAYER_ERRORS, PLAYER_STATE } from '../lib/youtube.js';

const PLAYER_VARS = {
  rel: 0, // don't suggest videos from other channels at the end
  playsinline: 1, // stay inline on mobile instead of jumping to fullscreen
  modestbranding: 1,
};

/**
 * Thin wrapper around the YouTube IFrame Player API.
 *
 * It owns the player's lifecycle and exposes a stable handle through `ref`:
 *   play(), pause(), seekTo(seconds), loadVideo(id, startSeconds),
 *   getCurrentTime(), getPlayerState(), getPlayer()
 *
 * It deliberately does NOT decide which video to show. Video and playback are
 * room state owned by the server, and applying that state is VideoPanel's job -
 * see the "make the player match the room" effect there. Keeping that policy in
 * one place is what prevents a seek being issued before the video is cued.
 *
 * The player is still built exactly once: the creation effect has an empty
 * dependency list, so nothing the parent does can rebuild the iframe.
 *
 * status: 'loading' while the API/player initialises, 'ready' once usable,
 *         'failed' if the API itself could not be loaded.
 */
export default function YouTubePlayer({ ref, lockControls, onReady, onStateChange, onVideoError }) {
  const wrapperRef = useRef(null);
  const playerRef = useRef(null);
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState('');
  const [videoError, setVideoError] = useState('');

  // Callbacks live in a ref so the creation effect never needs them as
  // dependencies. Otherwise an inline arrow prop from the parent would tear the
  // player down and rebuild it on every single render.
  const callbacksRef = useRef({ onReady, onStateChange, onVideoError });
  useEffect(() => {
    callbacksRef.current = { onReady, onStateChange, onVideoError };
  });

  useEffect(() => {
    let cancelled = false;
    const wrapper = wrapperRef.current;
    if (!wrapper) return undefined;

    // YT.Player *replaces* the element it is handed with an <iframe>. Giving it
    // a throwaway child keeps the wrapper reusable, which matters because React
    // StrictMode mounts, unmounts and remounts effects in development.
    const mount = document.createElement('div');
    mount.className = 'h-full w-full';
    wrapper.appendChild(mount);

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled) return;

        playerRef.current = new YT.Player(mount, {
          width: '100%',
          height: '100%',
          playerVars: PLAYER_VARS,
          events: {
            onReady: (event) => {
              setStatus('ready');
              callbacksRef.current.onReady?.(event.target);
            },
            onStateChange: (event) => {
              callbacksRef.current.onStateChange?.(event.data);
            },
            onError: (event) => {
              setVideoError(PLAYER_ERRORS[event.data] ?? 'This video could not be played.');
              callbacksRef.current.onVideoError?.(event.data);
            },
          },
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setStatus('failed');
        setMessage(error.message);
      });

    return () => {
      cancelled = true;
      try {
        playerRef.current?.destroy();
      } catch {
        // destroy() throws when the iframe is already gone; nothing to repair.
      }
      playerRef.current = null;
      wrapper.replaceChildren();
    };
  }, []);

  const containerRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const toggleFullscreen = () => {
    const target = containerRef.current;
    if (!target) return;

    if (!document.fullscreenElement) {
      if (target.requestFullscreen) {
        target.requestFullscreen().catch(() => {});
      } else if (target.webkitRequestFullscreen) {
        target.webkitRequestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    }
  };

  useImperativeHandle(
    ref,
    () => ({
      play: () => playerRef.current?.playVideo?.(),
      pause: () => playerRef.current?.pauseVideo?.(),
      seekTo: (seconds, allowSeekAhead = true) => playerRef.current?.seekTo?.(seconds, allowSeekAhead),
      // If autoPlay is requested, loadVideoById starts playback immediately.
      // cueVideoById loads without playing.
      loadVideo: (id, startSeconds = 0, autoPlay = false) => {
        setVideoError('');
        if (autoPlay) {
          playerRef.current?.loadVideoById?.({ videoId: id, startSeconds });
        } else {
          playerRef.current?.cueVideoById?.({ videoId: id, startSeconds });
        }
      },
      getCurrentTime: () => playerRef.current?.getCurrentTime?.() ?? 0,
      getPlayerState: () => playerRef.current?.getPlayerState?.() ?? PLAYER_STATE.UNSTARTED,
      getPlayer: () => playerRef.current,
      toggleFullscreen,
      isFullscreen,
    }),
    [isFullscreen],
  );

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={containerRef}
        className={`relative aspect-video w-full overflow-hidden rounded-xl border border-slate-800 bg-black ${
          isFullscreen ? 'h-screen w-screen rounded-none border-none' : ''
        }`}
      >
        <div ref={wrapperRef} className="h-full w-full" />

        {lockControls && (
          // Covers the iframe so participants cannot pause or scrub,
          // but double-clicking toggles fullscreen.
          <div
            className="absolute inset-0 z-10 cursor-default"
            onDoubleClick={toggleFullscreen}
            title="Double-click to toggle fullscreen (Host/Moderator controls playback)"
          />
        )}

        {/* Fullscreen Button - accessible to Hosts, Moderators, and Participants alike */}
        {status === 'ready' && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleFullscreen();
            }}
            className="absolute bottom-3 right-3 z-20 flex items-center gap-1.5 rounded-lg border border-slate-700/80 bg-slate-950/80 px-2.5 py-1.5 text-xs font-medium text-slate-200 shadow-xl backdrop-blur-md transition hover:border-slate-500 hover:bg-slate-900 hover:text-white hover:scale-105 active:scale-95"
            title={isFullscreen ? 'Exit Fullscreen (Esc)' : 'Full Screen'}
          >
            {isFullscreen ? (
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9L4 4m0 0v4m0-4h4m6 6l5 5m0 0v-4m0 4h-4" />
              </svg>
            ) : (
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0-4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              </svg>
            )}
            <span className="hidden sm:inline">{isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}</span>
          </button>
        )}

        {status !== 'ready' && (
          <p
            className={`absolute inset-0 flex items-center justify-center bg-slate-950/85 px-6 text-center text-sm ${
              status === 'failed' ? 'text-red-300' : 'text-slate-400'
            }`}
          >
            {status === 'failed' ? message : 'Loading the YouTube player...'}
          </p>
        )}
      </div>

      {videoError && <p className="text-sm text-red-300">{videoError}</p>}
    </div>
  );
}
