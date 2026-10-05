const SCRIPT_ID = 'youtube-iframe-api';
const SCRIPT_SRC = 'https://www.youtube.com/iframe_api';
const LOAD_TIMEOUT_MS = 15000;

// Cached at module scope: every caller shares one load instead of injecting a
// second <script> tag.
let apiPromise = null;

/**
 * Loads the YouTube IFrame API exactly once.
 *
 * The API is a single global script. When it finishes it assigns `window.YT`
 * and calls `window.onYouTubeIframeAPIReady` - which is a one-slot global, so
 * this module owns it and hands out a promise instead.
 */
export function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve, reject) => {
    let timer;

    // Clears the timeout and resets the cache so a failed load can be retried.
    const finish = (callback, value) => {
      clearTimeout(timer);
      apiPromise = null;
      callback(value);
    };

    timer = setTimeout(
      () => finish(reject, new Error('The YouTube player took too long to load.')),
      LOAD_TIMEOUT_MS,
    );

    // Chain any previously registered callback rather than clobbering it.
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === 'function') previous();
      finish(resolve, window.YT);
    };

    // A script injected by someone else will still trigger the callback above.
    if (document.getElementById(SCRIPT_ID)) return;

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onerror = () => finish(reject, new Error('Could not load the YouTube IFrame API.'));
    document.head.appendChild(script);
  });

  return apiPromise;
}
