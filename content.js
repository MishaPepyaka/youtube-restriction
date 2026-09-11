(function () {
  "use strict";

  const CACHE_KEY = "subscribedChannelIdentifiers";
  const CACHE_TIME_KEY = "subscribedChannelIdentifiersUpdatedAt";
  const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
  const SCAN_DELAY_MS = 120;
  const AUTO_LIKE_DELAY_MS = 3000;
  const AUTO_LIKE_RETRY_MS = 500;
  const AUTO_LIKE_MAX_ATTEMPTS = 20;

  const SHORTS_SELECTORS = [
    "ytd-rich-shelf-renderer[is-shorts]",
    "ytd-reel-shelf-renderer",
    "ytd-reel-video-renderer",
    "ytd-shorts",
    "ytm-shorts-lockup-view-model"
  ];

  const RECOMMENDATION_CARD_SELECTORS = [
    "ytd-rich-item-renderer",
    "ytd-compact-video-renderer",
    "ytd-video-renderer",
    "yt-lockup-view-model"
  ];

  let subscribedIdentifiers = new Set();
  let subscriptionsReady = false;
  let scanTimer = null;
  let autoLikeTimer = null;
  const handledVideoIds = new Set();

  function normalizeIdentifier(value) {
    if (!value) return null;

    try {
      const url = new URL(value, location.origin);
      const match = url.pathname.match(/^\/(?:channel\/([^/]+)|(@[^/]+))/i);
      return match ? (match[1] || match[2]).toLowerCase() : null;
    } catch {
      return String(value).replace(/^\/+|\/+$/g, "").toLowerCase() || null;
    }
  }

  function walk(value, visitor) {
    if (!value || typeof value !== "object") return;
    visitor(value);
    for (const child of Object.values(value)) walk(child, visitor);
  }

  function extractInitialData(html) {
    const markers = [
      "var ytInitialData = ",
      "window[\"ytInitialData\"] = ",
      "ytInitialData = "
    ];

    for (const marker of markers) {
      const markerIndex = html.indexOf(marker);
      if (markerIndex === -1) continue;

      const start = html.indexOf("{", markerIndex + marker.length);
      if (start === -1) continue;

      let depth = 0;
      let inString = false;
      let escaped = false;

      for (let index = start; index < html.length; index += 1) {
        const character = html[index];

        if (inString) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === "\"") inString = false;
          continue;
        }

        if (character === "\"") inString = true;
        else if (character === "{") depth += 1;
        else if (character === "}" && --depth === 0) {
          return JSON.parse(html.slice(start, index + 1));
        }
      }
    }

    throw new Error("YouTube subscription data was not found.");
  }

  function extractSubscriptionIdentifiers(data) {
    const identifiers = new Set();

    walk(data, (node) => {
      const renderer = node.channelRenderer || node.gridChannelRenderer;
      if (!renderer) return;

      const browseId = renderer.channelId ||
        renderer.navigationEndpoint?.browseEndpoint?.browseId;
      const canonicalUrl = renderer.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl;

      for (const value of [browseId, canonicalUrl]) {
        const normalized = normalizeIdentifier(value);
        if (normalized) identifiers.add(normalized);
      }
    });

    return identifiers;
  }

  async function loadSubscriptions() {
    const cached = await chrome.storage.local.get([CACHE_KEY, CACHE_TIME_KEY]);
    const isFresh = Date.now() - (cached[CACHE_TIME_KEY] || 0) < CACHE_MAX_AGE_MS;

    if (isFresh && Array.isArray(cached[CACHE_KEY]) && cached[CACHE_KEY].length) {
      subscribedIdentifiers = new Set(cached[CACHE_KEY]);
      subscriptionsReady = true;
      scheduleScan();
      return;
    }

    try {
      const response = await fetch("/feed/channels", {
        credentials: "include",
        cache: "no-store"
      });
      if (!response.ok) throw new Error(`Subscriptions request failed: ${response.status}`);

      const identifiers = extractSubscriptionIdentifiers(
        extractInitialData(await response.text())
      );
      if (!identifiers.size) throw new Error("No subscribed channels were found.");

      subscribedIdentifiers = identifiers;
      await chrome.storage.local.set({
        [CACHE_KEY]: [...identifiers],
        [CACHE_TIME_KEY]: Date.now()
      });
    } catch (error) {
      console.warn("[Intentional YouTube] Subscription list unavailable.", error);
      subscribedIdentifiers = new Set(cached[CACHE_KEY] || []);
    } finally {
      subscriptionsReady = true;
      scheduleScan();
    }
  }

  function hide(element) {
    element.dataset.intentionalYoutubeHidden = "true";
  }

  function filterOut(element) {
    element.dataset.intentionalYoutubeFiltered = "true";
  }

  function removeShorts(root) {
    for (const selector of SHORTS_SELECTORS) {
      root.querySelectorAll?.(selector).forEach(hide);
    }

    root.querySelectorAll?.('a[href^="/shorts"]').forEach((link) => {
      const container = link.closest(
        "ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer, " +
        "ytd-compact-video-renderer, ytd-guide-entry-renderer, " +
        "ytd-mini-guide-entry-renderer, yt-lockup-view-model"
      );
      hide(container || link);
    });
  }

  function isRecommendationArea(card) {
    return Boolean(card.closest(
      "ytd-browse[page-subtype='home'], ytd-watch-next-secondary-results-renderer"
    ));
  }

  function getChannelIdentifiers(card) {
    const identifiers = new Set();
    const links = card.querySelectorAll(
      "ytd-channel-name a[href], #channel-name a[href], " +
      "a.yt-simple-endpoint.yt-formatted-string[href^='/@'], " +
      "a.yt-simple-endpoint.yt-formatted-string[href^='/channel/'], " +
      "a.yt-lockup-metadata-view-model__avatar[href]"
    );

    links.forEach((link) => {
      const identifier = normalizeIdentifier(link.getAttribute("href"));
      if (identifier) identifiers.add(identifier);
    });

    return identifiers;
  }

  function filterRecommendations(root) {
    if (!subscriptionsReady) return;

    for (const selector of RECOMMENDATION_CARD_SELECTORS) {
      root.querySelectorAll?.(selector).forEach((card) => {
        if (!isRecommendationArea(card)) return;
        if (card.querySelector('a[href^="/shorts"]')) return hide(card);

        const identifiers = getChannelIdentifiers(card);
        const isSubscribed = [...identifiers].some((identifier) =>
          subscribedIdentifiers.has(identifier)
        );

        // Strict mode: unverifiable recommendations are hidden as well.
        if (!isSubscribed) filterOut(card);
        else delete card.dataset.intentionalYoutubeFiltered;
      });
    }
  }

  function scan() {
    scanTimer = null;
    removeShorts(document);
    filterRecommendations(document);
  }

  function scheduleScan() {
    if (scanTimer !== null) return;
    scanTimer = window.setTimeout(scan, SCAN_DELAY_MS);
  }

  function findLikeButton() {
    const selectors = [
      "#segmented-like-button button",
      "like-button-view-model button",
      "ytd-segmented-like-dislike-button-renderer button:first-of-type"
    ];

    for (const selector of selectors) {
      const button = document.querySelector(selector);
      if (button) return button;
    }

    return null;
  }

  function isAlreadyLiked(button) {
    if (button.getAttribute("aria-pressed") === "true") return true;
    if (button.getAttribute("title")?.toLowerCase() === "unlike") return true;

    const toggle = button.closest("ytd-toggle-button-renderer");
    return toggle?.classList.contains("style-default-active") ||
      toggle?.getAttribute("aria-pressed") === "true";
  }

  function attemptAutoLike(videoId, attempt = 0) {
    if (location.pathname !== "/watch" ||
        new URLSearchParams(location.search).get("v") !== videoId ||
        handledVideoIds.has(videoId)) return;

    const button = findLikeButton();
    if (!button && attempt < AUTO_LIKE_MAX_ATTEMPTS) {
      autoLikeTimer = window.setTimeout(
        () => attemptAutoLike(videoId, attempt + 1),
        AUTO_LIKE_RETRY_MS
      );
      return;
    }

    if (!button) {
      console.warn("[Intentional YouTube] Like button was not found.");
      return;
    }

    handledVideoIds.add(videoId);
    if (!isAlreadyLiked(button)) button.click();
  }

  function scheduleAutoLike() {
    window.clearTimeout(autoLikeTimer);
    autoLikeTimer = null;

    if (location.pathname !== "/watch") return;
    const videoId = new URLSearchParams(location.search).get("v");
    if (!videoId || handledVideoIds.has(videoId)) return;

    autoLikeTimer = window.setTimeout(
      () => attemptAutoLike(videoId),
      AUTO_LIKE_DELAY_MS
    );
  }

  function redirectRestrictedPage() {
    const isHomePage = location.pathname === "/";
    const isShortsPage = location.pathname.startsWith("/shorts");

    if (isHomePage || isShortsPage) location.replace("/feed/subscriptions");
  }

  function updatePageContext() {
    const isChannelPage = /^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/i
      .test(location.pathname);

    document.documentElement?.toggleAttribute(
      "data-intentional-youtube-channel-page",
      isChannelPage
    );
  }

  updatePageContext();
  redirectRestrictedPage();

  const observer = new MutationObserver(scheduleScan);
  function startObserving() {
    if (!document.documentElement) {
      window.setTimeout(startObserving, 0);
      return;
    }

    updatePageContext();
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
    scheduleScan();
  }

  startObserving();
  window.addEventListener("yt-navigate-finish", () => {
    updatePageContext();
    redirectRestrictedPage();
    scheduleScan();
    scheduleAutoLike();
  });

  loadSubscriptions();
  scheduleAutoLike();
})();
