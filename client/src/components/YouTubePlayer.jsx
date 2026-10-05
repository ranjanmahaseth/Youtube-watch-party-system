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

  useImperativeHandle(
    ref,
    () => ({
      play: () => playerRef.current?.playVideo?.(),
      pause: () => playerRef.current?.pauseVideo?.(),
      seekTo: (seconds, allowSeekAhead = true) => playerRef.current?.seekTo?.(seconds, allowSeekAhead),
      // cueVideoById loads without playing, so the caller decides playback.
      // `startSeconds` avoids the classic bug where a seek issued straight after
      // a load is lost, because the video has not been cued yet.
      loadVideo: (id, startSeconds = 0) => {
        setVideoError('');
        playerRef.current?.cueVideoById?.({ videoId: id, startSeconds });
      },
      getCurrentTime: () => playerRef.current?.getCurrentTime?.() ?? 0,
      getPlayerState: () => playerRef.current?.getPlayerState?.() ?? PLAYER_STATE.UNSTARTED,
      getPlayer: () => playerRef.current,
    }),
    [],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-slate-800 bg-black">
        <div ref={wrapperRef} className="h-full w-full" />

        {lockControls && (
          // Covers the iframe so the embed's own controls cannot be reached.
          // This is only a UX guard: the server refuses playback from
          // participants no matter what the client sends.
          <div
            className="absolute inset-0 z-10 cursor-not-allowed"
            title="Only the host or a moderator can control playback"
          />
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
