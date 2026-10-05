const SEARCH_HISTORY_KEY = 'wwp:searchHistory';
const MAX_HISTORY_ITEMS = 20;

/**
 * Returns the list of recent search queries from localStorage.
 */
export function getSearchHistory() {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Saves a new search query to the top of localStorage history.
 */
export function saveSearchHistory(term) {
  const clean = String(term ?? '').trim();
  if (!clean) return getSearchHistory();

  try {
    const existing = getSearchHistory();
    // Case-insensitive deduplication: remove if already exists
    const filtered = existing.filter((item) => item.toLowerCase() !== clean.toLowerCase());
    // Prepend the new search term
    const updated = [clean, ...filtered].slice(0, MAX_HISTORY_ITEMS);
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(updated));
    return updated;
  } catch {
    return [];
  }
}

/**
 * Removes a specific search term from localStorage history.
 */
export function removeSearchHistoryItem(term) {
  try {
    const existing = getSearchHistory();
    const updated = existing.filter((item) => item.toLowerCase() !== String(term ?? '').trim().toLowerCase());
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(updated));
    return updated;
  } catch {
    return [];
  }
}

/**
 * Clears all search history from localStorage.
 */
export function clearSearchHistory() {
  try {
    localStorage.removeItem(SEARCH_HISTORY_KEY);
    return [];
  } catch {
    return [];
  }
}

