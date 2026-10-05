const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const CACHE_TTL_MS = 5 * 60 * 1000;
const searchCache = new Map();

function cleanCache() {
  const now = Date.now();
  for (const [key, entry] of searchCache.entries()) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      searchCache.delete(key);
    }
  }
}

/**
 * Extracts 11-char video ID from input string or URL.
 */
export function extractVideoId(input) {
  const value = String(input ?? '').trim();
  if (!value) return null;
  if (VIDEO_ID_PATTERN.test(value)) return value;

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withProtocol);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();

    if (host === 'youtu.be') {
      const candidate = url.pathname.slice(1).split('/')[0];
      return VIDEO_ID_PATTERN.test(candidate) ? candidate : null;
    }

    if (
      host === 'youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'music.youtube.com' ||
      host === 'youtube-nocookie.com'
    ) {
      const v = url.searchParams.get('v');
      if (v && VIDEO_ID_PATTERN.test(v)) return v;

      const parts = url.pathname.split('/').filter(Boolean);
      if (['embed', 'v', 'shorts', 'live'].includes(parts[0]) && parts[1]) {
        return VIDEO_ID_PATTERN.test(parts[1]) ? parts[1] : null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Searches YouTube for videos matching a query, or returns details if a direct link was given.
 */
export async function searchYouTube(rawQuery) {
  const query = String(rawQuery ?? '').trim();
  if (!query) return [];

  cleanCache();
  const cached = searchCache.get(query.toLowerCase());
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.results;
  }

  // 1. Direct YouTube link or ID check
  const directId = extractVideoId(query);
  if (directId) {
    try {
      const oembedRes = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${directId}&format=json`,
        { signal: AbortSignal.timeout(4000) },
      );
      if (oembedRes.ok) {
        const info = await oembedRes.json();
        const singleResult = [
          {
            id: directId,
            title: info.title || `Video (${directId})`,
            channel: info.author_name || 'YouTube',
            thumbnail: info.thumbnail_url || `https://i.ytimg.com/vi/${directId}/hqdefault.jpg`,
            duration: '',
            views: '',
            isDirect: true,
          },
        ];
        searchCache.set(query.toLowerCase(), { timestamp: Date.now(), results: singleResult });
        return singleResult;
      }
    } catch {
      // Fall through to fallback direct item
    }

    const fallbackDirect = [
      {
        id: directId,
        title: `Video (${directId})`,
        channel: 'YouTube',
        thumbnail: `https://i.ytimg.com/vi/${directId}/hqdefault.jpg`,
        duration: '',
        views: '',
        isDirect: true,
      },
    ];
    searchCache.set(query.toLowerCase(), { timestamp: Date.now(), results: fallbackDirect });
    return fallbackDirect;
  }

  // 2. Official YouTube Data API v3 if API key is provided
  if (process.env.YOUTUBE_API_KEY) {
    try {
      const apiKey = process.env.YOUTUBE_API_KEY;
      const apiUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${encodeURIComponent(
        query,
      )}&maxResults=15&key=${apiKey}`;
      const res = await fetch(apiUrl, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        const results = (data.items || [])
          .map((item) => ({
            id: item.id?.videoId,
            title: item.snippet?.title || 'Untitled',
            channel: item.snippet?.channelTitle || 'Unknown Channel',
            thumbnail:
              item.snippet?.thumbnails?.medium?.url ||
              item.snippet?.thumbnails?.default?.url ||
              '',
            duration: '',
            views: '',
          }))
          .filter((v) => Boolean(v.id));

        searchCache.set(query.toLowerCase(), { timestamp: Date.now(), results });
        return results;
      }
    } catch (err) {
      console.warn('[search] YouTube API search failed, falling back to public search:', err.message);
    }
  }

  // 3. Public search scraping fallback (no API key required)
  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(6000),
    });

    if (!response.ok) {
      throw new Error(`YouTube search returned status ${response.status}`);
    }

    const html = await response.text();
    const match =
      html.match(/var ytInitialData = ({.*?});<\/script>/) ||
      html.match(/ytInitialData\s*=\s*({.+?});/);

    if (!match) {
      throw new Error('Could not parse ytInitialData from YouTube search results');
    }

    const data = JSON.parse(match[1]);
    const sections =
      data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer
        ?.contents || [];

    const results = [];
    for (const sec of sections) {
      const items = sec?.itemSectionRenderer?.contents || [];
      for (const item of items) {
        if (item.videoRenderer) {
          const v = item.videoRenderer;
          const id = v.videoId;
          if (!id || !VIDEO_ID_PATTERN.test(id)) continue;

          const title =
            v.title?.runs?.map((r) => r.text).join('') || v.title?.simpleText || 'Untitled';
          const channel =
            v.ownerText?.runs?.[0]?.text || v.longBylineText?.runs?.[0]?.text || '';
          const duration = v.lengthText?.simpleText || '';
          const thumbs = v.thumbnail?.thumbnails || [];
          const thumbnail =
            thumbs[thumbs.length - 1]?.url ||
            thumbs[0]?.url ||
            `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
          const views = v.viewCountText?.simpleText || v.shortViewCountText?.simpleText || '';

          results.push({
            id,
            title,
            channel,
            duration,
            thumbnail,
            views,
          });

          if (results.length >= 15) break;
        }
      }
      if (results.length >= 15) break;
    }

    searchCache.set(query.toLowerCase(), { timestamp: Date.now(), results });
    return results;
  } catch (error) {
    console.error('[search] YouTube search error:', error.message);
    throw error;
  }
}

