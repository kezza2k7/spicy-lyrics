import cors from "cors";
import dotenv from "dotenv";
import express, { type Request, type Response } from "express";
import type { IncomingHttpHeaders } from "node:http";

dotenv.config();

type QueryVariables = {
  id?: string;
  trackId?: string;
  songId?: string;
  market?: string;
  storefront?: string;
  auth?: string;
  spotifyToken?: string;
  appleSongId?: string;
  appleStorefront?: string;
  appleDeveloperToken?: string;
  appleUserToken?: string;
  // client-supplied track metadata (avoids backend API call)
  trackName?: string;
  trackArtists?: string[];
  trackDurationMs?: number;
};

type QueryInput = {
  operation?: string;
  variables?: QueryVariables;
};

type QueryResult = {
  data: unknown;
  httpStatus: number;
  format: "json" | "text";
};

type QueryResponseItem = {
  operation: string;
  operationId: string;
  result: QueryResult;
};

type SpicyLineContent = {
  Type: "Vocal";
  OppositeAligned: boolean;
  Text: string;
  StartTime: number;
  EndTime: number;
};

type SpicyLineLyrics = {
  id: string;
  Type: "Line";
  StartTime: number;
  EndTime?: number;
  Content: SpicyLineContent[];
  source: "spt" | "aml";
  Provider: string;
  ProviderDisplayName: string;
  Language: string;
  IsRtlLanguage: boolean;
  IncludesRomanization: boolean;
  SongWriters: string[];
};

type SpicySyllable = {
  Text: string;
  StartTime: number;
  EndTime: number;
  IsPartOfWord: boolean;
};

type SpicySyllableContent = {
  Type: "Vocal";
  OppositeAligned: boolean;
  Lead: {
    Syllables: SpicySyllable[];
    StartTime: number;
    EndTime: number;
  };
};

type SpicySyllableLyrics = {
  id: string;
  Type: "Syllable";
  StartTime: number;
  EndTime?: number;
  Content: SpicySyllableContent[];
  source: "aml";
  Provider: string;
  ProviderDisplayName: string;
  Language: string;
  IsRtlLanguage: boolean;
  IncludesRomanization: boolean;
  SongWriters: string[];
};

type SpotifyTrackMeta = {
  id: string;
  name: string;
  artists: string[];
  durationMs: number;
};

type AppleSongCandidate = {
  id: string;
  name: string;
  artistName: string;
  durationMs: number;
};

type SpotifyLyricsRequest = {
  trackId?: string;
  market?: string;
};

type AppleLyricsRequest = {
  songId?: string;
  storefront?: string;
  appleDeveloperToken?: string;
  appleUserToken?: string;
  authorization?: string;
  mediaUserToken?: string;
};

type HeaderCarrier = {
  headers: IncomingHttpHeaders;
};

type AppleAuth = {
  authorization: string;
  userToken: string;
};

const app = express();
const PORT = Number(process.env.PORT || 3000);

// In-memory cache for Spotify track metadata to avoid hitting Web API rate limits
const spotifyMetaCache = new Map<string, { data: SpotifyTrackMeta; expiresAt: number }>();
const SPOTIFY_META_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const LOG_ENABLED = process.env.BACKEND_LOGGING !== "false";

function logInfo(scope: string, message: string, meta?: unknown): void {
  if (!LOG_ENABLED) return;
  const timestamp = new Date().toISOString();
  if (meta !== undefined) {
    console.log(`[${timestamp}] [INFO] [${scope}] ${message}`, meta);
    return;
  }
  console.log(`[${timestamp}] [INFO] [${scope}] ${message}`);
}

function logWarn(scope: string, message: string, meta?: unknown): void {
  if (!LOG_ENABLED) return;
  const timestamp = new Date().toISOString();
  if (meta !== undefined) {
    console.warn(`[${timestamp}] [WARN] [${scope}] ${message}`, meta);
    return;
  }
  console.warn(`[${timestamp}] [WARN] [${scope}] ${message}`);
}

function logError(scope: string, message: string, meta?: unknown): void {
  const timestamp = new Date().toISOString();
  if (meta !== undefined) {
    console.error(`[${timestamp}] [ERROR] [${scope}] ${message}`, meta);
    return;
  }
  console.error(`[${timestamp}] [ERROR] [${scope}] ${message}`);
}

function summarizeBody(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const clone = { ...(body as Record<string, unknown>) };
  if (typeof clone.authorization === "string") clone.authorization = "[REDACTED]";
  if (typeof clone.appleDeveloperToken === "string") clone.appleDeveloperToken = "[REDACTED]";
  if (typeof clone.appleUserToken === "string") clone.appleUserToken = "[REDACTED]";
  if (typeof clone.mediaUserToken === "string") clone.mediaUserToken = "[REDACTED]";
  if (typeof clone.spotifyToken === "string") clone.spotifyToken = "[REDACTED]";
  return clone;
}

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  const started = Date.now();
  logInfo("http", `${req.method} ${req.originalUrl} incoming`, {
    body: summarizeBody(req.body),
  });

  res.on("finish", () => {
    logInfo("http", `${req.method} ${req.originalUrl} completed`, {
      statusCode: res.statusCode,
      durationMs: Date.now() - started,
    });
  });

  next();
});

function normalizeHeaderValue(value: string | string[] | undefined): string {
  if (!value) return "";
  if (Array.isArray(value)) return value[0]?.trim() ?? "";
  return value.trim();
}

function resolveAppleAuth(params: {
  carrier?: HeaderCarrier;
  developerToken?: string;
  authorization?: string;
  userToken?: string;
}): AppleAuth {
  const headers = params.carrier?.headers;

  const authorization =
    params.developerToken ||
    params.authorization ||
    normalizeHeaderValue(headers?.authorization) ||
    process.env.APPLE_AUTHORIZATION ||
    process.env.APPLE_MUSIC_DEVELOPER_TOKEN ||
    "";

  const userToken =
    params.userToken ||
    normalizeHeaderValue(headers?.["media-user-token"]) ||
    normalizeHeaderValue(headers?.["music-user-token"]) ||
    process.env.APPLE_MEDIA_USER_TOKEN ||
    process.env.APPLE_MUSIC_USER_TOKEN ||
    "";

  return { authorization, userToken };
}

function toSeconds(value: string | number | undefined): number {
  if (value === undefined || value === null) return 0;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return numeric / 1000;
}

function parseAppleTimestampToSeconds(value: string): number {
  const cleaned = value.trim();
  const parts = cleaned.split(":");

  if (parts.length === 3) {
    const hours = Number(parts[0]) || 0;
    const minutes = Number(parts[1]) || 0;
    const seconds = Number(parts[2]) || 0;
    return hours * 3600 + minutes * 60 + seconds;
  }

  if (parts.length === 2) {
    const minutes = Number(parts[0]) || 0;
    const seconds = Number(parts[1]) || 0;
    return minutes * 60 + seconds;
  }

  return Number(cleaned) || 0;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function normalizeForCompare(value: string): string {
  return value
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]|\{.*?\}/g, " ")
    .replace(/\b(feat\.|ft\.|version|remaster(ed)?|live|mono|stereo|deluxe|edit)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function pickBestAppleCandidate(track: SpotifyTrackMeta, candidates: AppleSongCandidate[]): AppleSongCandidate | null {
  const normalizedTitle = normalizeForCompare(track.name);
  const normalizedArtist = normalizeForCompare(track.artists[0] ?? "");

  let best: AppleSongCandidate | null = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    const candidateTitle = normalizeForCompare(candidate.name);
    const candidateArtist = normalizeForCompare(candidate.artistName);
    const durationDiffSec = Math.abs(candidate.durationMs - track.durationMs) / 1000;

    let score = 0;
    if (candidateTitle === normalizedTitle) score += 60;
    else if (candidateTitle.includes(normalizedTitle) || normalizedTitle.includes(candidateTitle)) score += 30;

    if (normalizedArtist && candidateArtist.includes(normalizedArtist)) score += 30;

    if (durationDiffSec <= 2) score += 20;
    else if (durationDiffSec <= 5) score += 12;
    else if (durationDiffSec <= 10) score += 6;

    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return bestScore >= 45 ? best : null;
}

function extractAppleTtml(raw: unknown): string {
  const isTtml = (value: unknown): value is string =>
    typeof value === "string" && value.includes("<tt");

  const scan = (value: unknown): string => {
    if (isTtml(value)) return value;

    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = scan(item);
        if (hit) return hit;
      }
      return "";
    }

    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const priorityKeys = ["ttml", "ttmlLocalizations", "attributes", "data"];

      for (const key of priorityKeys) {
        if (key in obj) {
          const hit = scan(obj[key]);
          if (hit) return hit;
        }
      }

      for (const nested of Object.values(obj)) {
        const hit = scan(nested);
        if (hit) return hit;
      }
    }

    return "";
  };

  return scan(raw);
}

function isAppleWordByWord(raw: unknown): boolean {
  const ttml = extractAppleTtml(raw);
  if (!ttml) return false;

  // Apple marks word-level timing explicitly on many payloads.
  if (/itunes:timing\s*=\s*"Word"/i.test(ttml)) return true;

  // Fallback heuristic: timed span tokens usually indicate word/syllable timing.
  return /<span\b[^>]*begin="[^"]+"[^>]*end="[^"]+"/i.test(ttml);
}

function roundTime(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function extractAppleSongWriters(ttml: string): string[] {
  const writers: string[] = [];
  const regex = /<songwriter>([\s\S]*?)<\/songwriter>/g;
  let match: RegExpExecArray | null = regex.exec(ttml);

  while (match) {
    const name = decodeHtmlEntities((match[1] ?? "").replace(/<[^>]+>/g, "").trim());
    if (name && !writers.includes(name)) {
      writers.push(name);
    }
    match = regex.exec(ttml);
  }

  return writers;
}

function normalizeLineTiming(lines: SpicyLineContent[]): void {
  lines.sort((a, b) => a.StartTime - b.StartTime);

  const minDuration = 0.05;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    line.StartTime = roundTime(line.StartTime);
    line.EndTime = roundTime(line.EndTime);

    if (line.EndTime <= line.StartTime) {
      line.EndTime = line.StartTime + minDuration;
    }

    if (i < lines.length - 1) {
      const next = lines[i + 1];
      // Keep natural pauses, only remove overlaps.
      if (line.EndTime > next.StartTime) {
        line.EndTime = next.StartTime;
      }
      if (line.EndTime <= line.StartTime) {
        line.EndTime = line.StartTime + minDuration;
      }
    }
  }
}

function normalizeSyllableTiming(lines: SpicySyllableContent[]): void {
  lines.sort((a, b) => a.Lead.StartTime - b.Lead.StartTime);

  const minDuration = 0.03;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const currentLine = lines[lineIndex];
    const syllables = currentLine.Lead.Syllables.sort((a, b) => a.StartTime - b.StartTime);

    for (let i = 0; i < syllables.length; i++) {
      const current = syllables[i];
      current.StartTime = roundTime(current.StartTime);
      current.EndTime = roundTime(current.EndTime);

      if (current.EndTime <= current.StartTime) {
        current.EndTime = current.StartTime + minDuration;
      }
    }

    for (let i = 0; i < syllables.length - 1; i++) {
      const current = syllables[i];
      const next = syllables[i + 1];

      // Keep natural pauses between words, only remove overlap.
      if (current.EndTime > next.StartTime) {
        current.EndTime = next.StartTime;
      }

      if (current.EndTime <= current.StartTime) {
        current.EndTime = current.StartTime + minDuration;
      }
    }

    if (syllables.length > 0) {
      const last = syllables[syllables.length - 1];
      if (last.EndTime <= last.StartTime) {
        last.EndTime = last.StartTime + minDuration;
      }

      currentLine.Lead.StartTime = syllables[0].StartTime;
      currentLine.Lead.EndTime = last.EndTime;
    }
  }
}

function transformAppleToSpicyLyrics(raw: unknown, songId?: string): SpicyLineLyrics | SpicySyllableLyrics | null {
  const ttml = extractAppleTtml(raw);
  if (!ttml) return null;
  const songWriters = extractAppleSongWriters(ttml);

  const wordByWord = isAppleWordByWord(raw);

  if (wordByWord) {
    const lineRegex = /<p\b[^>]*begin="([^"]+)"[^>]*end="([^"]+)"[^>]*>([\s\S]*?)<\/p>/g;
    const syllableContent: SpicySyllableContent[] = [];

    let lineMatch: RegExpExecArray | null = lineRegex.exec(ttml);
    while (lineMatch) {
      const lineStart = parseAppleTimestampToSeconds(lineMatch[1]);
      const lineEnd = parseAppleTimestampToSeconds(lineMatch[2]);
      const lineInner = lineMatch[3] ?? "";

      const spanRegex = /<span\b[^>]*begin="([^"]+)"[^>]*end="([^"]+)"[^>]*>([\s\S]*?)<\/span>/g;
      const syllables: SpicySyllable[] = [];
      let previousSpanEndIndex = 0;
      let spanMatch: RegExpExecArray | null = spanRegex.exec(lineInner);

      while (spanMatch) {
        const betweenText = decodeHtmlEntities(
          lineInner.slice(previousSpanEndIndex, spanMatch.index).replace(/<[^>]+>/g, "")
        );
        const isPartOfWord = syllables.length > 0 && !/\s/.test(betweenText);
        const text = decodeHtmlEntities((spanMatch[3] ?? "").replace(/<[^>]+>/g, "").trim());

        if (text) {
          const startTime = parseAppleTimestampToSeconds(spanMatch[1]);
          const endTime = parseAppleTimestampToSeconds(spanMatch[2]);
          syllables.push({
            Text: text,
            StartTime: startTime,
            EndTime: endTime > startTime ? endTime : startTime + 0.2,
            IsPartOfWord: isPartOfWord,
          });
        }

        previousSpanEndIndex = spanRegex.lastIndex;
        spanMatch = spanRegex.exec(lineInner);
      }

      if (syllables.length === 0) {
        const fallbackText = decodeHtmlEntities(lineInner.replace(/<[^>]+>/g, "").trim());
        if (fallbackText) {
          syllables.push({
            Text: fallbackText,
            StartTime: lineStart,
            EndTime: lineEnd > lineStart ? lineEnd : lineStart + 1,
            IsPartOfWord: false,
          });
        }
      }

      if (syllables.length > 0) {
        const leadStart = syllables[0]?.StartTime ?? lineStart;
        const leadEnd = syllables[syllables.length - 1]?.EndTime ?? lineEnd;
        syllableContent.push({
          Type: "Vocal",
          OppositeAligned: false,
          Lead: {
            Syllables: syllables,
            StartTime: leadStart,
            EndTime: leadEnd > leadStart ? leadEnd : leadStart + 1,
          },
        });
      }

      lineMatch = lineRegex.exec(ttml);
    }

    if (syllableContent.length > 0) {
      normalizeSyllableTiming(syllableContent);
      return {
        id: songId ?? "",
        Type: "Syllable",
        StartTime: syllableContent[0]?.Lead.StartTime ?? 0,
        EndTime: syllableContent[syllableContent.length - 1]?.Lead.EndTime ?? 0,
        Content: syllableContent,
        source: "aml",
        Provider: "AppleMusic",
        ProviderDisplayName: "Apple Music",
        Language: "und",
        IsRtlLanguage: false,
        IncludesRomanization: false,
        SongWriters: songWriters,
      };
    }
  }

  const lineRegex = /<p\b[^>]*begin="([^"]+)"[^>]*end="([^"]+)"[^>]*>([\s\S]*?)<\/p>/g;
  const content: SpicyLineContent[] = [];

  let match: RegExpExecArray | null = lineRegex.exec(ttml);
  while (match) {
    const startTime = parseAppleTimestampToSeconds(match[1]);
    const endTime = parseAppleTimestampToSeconds(match[2]);
    const text = decodeHtmlEntities(match[3].replace(/<[^>]+>/g, "").trim());

    if (text) {
      content.push({
        Type: "Vocal",
        OppositeAligned: false,
        Text: text,
        StartTime: startTime,
        EndTime: endTime > startTime ? endTime : startTime + 2,
      });
    }

    match = lineRegex.exec(ttml);
  }

  if (content.length === 0) return null;
  normalizeLineTiming(content);

  return {
    id: songId ?? "",
    Type: "Line",
    StartTime: content[0]?.StartTime ?? 0,
    EndTime: content[content.length - 1]?.EndTime ?? 0,
    Content: content,
    source: "aml",
    Provider: "AppleMusic",
    ProviderDisplayName: "Apple Music",
    Language: "und",
    IsRtlLanguage: false,
    IncludesRomanization: false,
    SongWriters: songWriters,
  };
}

function transformSpotifyToSpicyLyrics(raw: unknown, trackId?: string): SpicyLineLyrics {
  const source = (raw ?? {}) as {
    lyrics?: {
      lines?: Array<{
        startTimeMs?: string | number;
        endTimeMs?: string | number;
        words?: string;
      }>;
      provider?: string;
      providerDisplayName?: string;
      language?: string;
      isRtlLanguage?: boolean;
    };
  };

  const rawLines = Array.isArray(source.lyrics?.lines) ? source.lyrics.lines : [];
  const vocalLines = rawLines.filter((line) => {
    const words = typeof line.words === "string" ? line.words.trim() : "";
    return words.length > 0;
  });

  const content: SpicyLineContent[] = vocalLines.map((line, index) => {
    const startTime = toSeconds(line.startTimeMs);
    const nextStartTime = toSeconds(vocalLines[index + 1]?.startTimeMs);
    const explicitEndTime = toSeconds(line.endTimeMs);

    const computedEndTime =
      explicitEndTime > startTime
        ? explicitEndTime
        : nextStartTime > startTime
          ? nextStartTime
          : startTime + 2;

    return {
      Type: "Vocal",
      OppositeAligned: false,
      Text: (line.words ?? "").trim(),
      StartTime: startTime,
      EndTime: computedEndTime,
    };
  });

  return {
    id: trackId ?? "",
    Type: "Line",
    StartTime: content[0]?.StartTime ?? 0,
    Content: content,
    source: "spt",
    Provider: source.lyrics?.provider ?? "Spotify",
    ProviderDisplayName: source.lyrics?.providerDisplayName ?? "Spotify",
    Language: source.lyrics?.language ?? "und",
    IsRtlLanguage: source.lyrics?.isRtlLanguage ?? false,
    IncludesRomanization: false,
    SongWriters: [],
  };
}

function pickAuthTokenFromQuery(variables: QueryVariables = {}, carrier: HeaderCarrier): string {
  if (typeof variables.auth === "string") {
    const dynamicHeader = normalizeHeaderValue(carrier.headers[variables.auth.toLowerCase()]);
    if (dynamicHeader) return dynamicHeader;
  }

  const authorization = normalizeHeaderValue(carrier.headers.authorization);
  if (authorization) return authorization;

  const spicyHeader = normalizeHeaderValue(carrier.headers["spicelyrics-webauth"]);
  if (spicyHeader) return spicyHeader;

  if (typeof variables.spotifyToken === "string" && variables.spotifyToken.trim()) {
    return variables.spotifyToken.trim();
  }

  if (typeof process.env.SPOTIFY_BEARER_TOKEN === "string" && process.env.SPOTIFY_BEARER_TOKEN.trim()) {
    return process.env.SPOTIFY_BEARER_TOKEN.trim();
  }

  return "";
}

async function fetchJsonWithFallback(url: URL | string, options: RequestInit = {}) {
  const method = options.method ?? "GET";
  const urlText = typeof url === "string" ? url : url.toString();
  logInfo("upstream", `Requesting ${method} ${urlText}`);

  const res = await fetch(url, options);

  const text = await res.text();
  let data: unknown = text;

  try {
    data = JSON.parse(text);
  } catch {
    // Preserve raw text if response body is not JSON.
  }

  return {
    ok: res.ok,
    status: res.status,
    data,
  };
}

async function askSpotifyForLyrics(params: {
  trackId?: string;
  market?: string;
  authorization?: string;
}): Promise<{ httpStatus: number; data: unknown }> {
  const { trackId, market = "from_token", authorization } = params;

  logInfo("spotify-lyrics", "Starting Spotify lyrics lookup", {
    trackId,
    market,
    hasAuthorization: Boolean(authorization),
  });

  if (!trackId) {
    return {
      httpStatus: 400,
      data: { message: "Missing Spotify track id." },
    };
  }

  if (!authorization) {
    return {
      httpStatus: 401,
      data: {
        message: "Missing Spotify bearer token. Provide Authorization, SpicyLyrics-WebAuth, spotifyToken, or SPOTIFY_BEARER_TOKEN.",
      },
    };
  }

  const authHeader = authorization.startsWith("Bearer ") ? authorization : `Bearer ${authorization}`;

  const spotifyUrl = new URL(`https://spclient.wg.spotify.com/color-lyrics/v2/track/${trackId}`);
  spotifyUrl.searchParams.set("format", "json");
  spotifyUrl.searchParams.set("vocalRemoval", "false");
  spotifyUrl.searchParams.set("market", market);

  const result = await fetchJsonWithFallback(spotifyUrl, {
    method: "GET",
    headers: {
      Authorization: authHeader,
      "app-platform": "WebPlayer",
      "spotify-app-version": "1.2.58.498.g6afe77b7",
      accept: "application/json",
    },
  });

  return {
    httpStatus: result.status,
    data: result.data,
  };
}

async function getSpotifyTrackMeta(params: {
  trackId?: string;
  authorization?: string;
}): Promise<SpotifyTrackMeta | null> {
  const { trackId, authorization } = params;
  if (!trackId || !authorization) return null;

  // Return cached result if still valid
  const cached = spotifyMetaCache.get(trackId);
  if (cached && cached.expiresAt > Date.now()) {
    logInfo("spotify-meta", "Returning cached Spotify track metadata", { trackId });
    return cached.data;
  }

  logInfo("spotify-meta", "Fetching Spotify track metadata", {
    trackId,
    hasAuthorization: Boolean(authorization),
  });

  const authHeader = authorization?.startsWith("Bearer ") ? authorization : `Bearer ${authorization}`;
  const trackUrl = `https://api.spotify.com/v1/tracks/${trackId}`;

  const result = await fetchJsonWithFallback(trackUrl, {
    method: "GET",
    headers: {
      Authorization: authHeader,
      accept: "application/json",
    },
  });

  if (!result.ok || typeof result.data !== "object" || result.data === null) {
    logWarn("spotify-meta", "Spotify metadata lookup failed", {
      trackId,
      status: result.status,
    });
    return null;
  }

  const data = result.data as {
    id?: string;
    name?: string;
    duration_ms?: number;
    artists?: Array<{ name?: string }>;
  };

  const meta: SpotifyTrackMeta = {
    id: data.id ?? trackId,
    name: data.name ?? "",
    artists: Array.isArray(data.artists) ? data.artists.map((artist) => artist.name ?? "").filter(Boolean) : [],
    durationMs: Number(data.duration_ms ?? 0),
  };

  spotifyMetaCache.set(trackId, { data: meta, expiresAt: Date.now() + SPOTIFY_META_CACHE_TTL_MS });
  return meta;
}

async function searchAppleSongFromSpotifyTrack(params: {
  spotifyTrack: SpotifyTrackMeta;
  storefront: string;
  authorization?: string;
  userToken?: string;
}): Promise<string | null> {
  const { spotifyTrack, storefront, authorization, userToken } = params;
  const token = authorization || process.env.APPLE_AUTHORIZATION || process.env.APPLE_MUSIC_DEVELOPER_TOKEN || "";

  const searchWithItunes = async (): Promise<string | null> => {
    const term = encodeURIComponent(`${spotifyTrack.name} ${spotifyTrack.artists[0] ?? ""}`.trim());
    const url = `https://itunes.apple.com/search?term=${term}&entity=song&limit=20`;

    logInfo("apple-search", "Falling back to iTunes search mapping", {
      spotifyTrackId: spotifyTrack.id,
      spotifyTrackName: spotifyTrack.name,
    });

    const result = await fetchJsonWithFallback(url, { method: "GET" });
    if (!result.ok || typeof result.data !== "object" || result.data === null) {
      logWarn("apple-search", "iTunes search fallback failed", {
        status: result.status,
      });
      return null;
    }

    const data = result.data as {
      results?: Array<{
        trackId?: number;
        trackName?: string;
        artistName?: string;
        trackTimeMillis?: number;
      }>;
    };

    const candidates: AppleSongCandidate[] = (data.results ?? [])
      .map((song) => ({
        id: String(song.trackId ?? ""),
        name: song.trackName ?? "",
        artistName: song.artistName ?? "",
        durationMs: Number(song.trackTimeMillis ?? 0),
      }))
      .filter((song) => song.id && song.name);

    const match = pickBestAppleCandidate(spotifyTrack, candidates);
    logInfo("apple-search", "iTunes mapping completed", {
      candidateCount: candidates.length,
      matchedSongId: match?.id ?? null,
      matchedSongName: match?.name ?? null,
    });
    return match?.id ?? null;
  };

  if (!token) {
    logWarn("apple-search", "No Apple authorization token for Apple catalog search; trying iTunes fallback");
    return await searchWithItunes();
  }

  logInfo("apple-search", "Searching Apple song from Spotify metadata", {
    spotifyTrackId: spotifyTrack.id,
    spotifyTrackName: spotifyTrack.name,
    spotifyArtists: spotifyTrack.artists,
    storefront,
    hasAuthorization: Boolean(token),
    hasUserToken: Boolean(userToken),
  });

  const term = encodeURIComponent(`${spotifyTrack.name} ${spotifyTrack.artists[0] ?? ""}`.trim());
  const url = `https://api.music.apple.com/v1/catalog/${storefront}/search?types=songs&limit=10&term=${term}`;

  const headers: Record<string, string> = {
    Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
    accept: "application/json",
  };
  if (userToken) {
    headers["Music-User-Token"] = userToken;
    headers["media-user-token"] = userToken;
  }

  const result = await fetchJsonWithFallback(url, { method: "GET", headers });
  if (!result.ok || typeof result.data !== "object" || result.data === null) {
    logWarn("apple-search", "Apple search failed", {
      status: result.status,
      storefront,
    });
    return await searchWithItunes();
  }

  const data = result.data as {
    results?: {
      songs?: {
        data?: Array<{
          id?: string;
          attributes?: {
            name?: string;
            artistName?: string;
            durationInMillis?: number;
          };
        }>;
      };
    };
  };

  const songs = data.results?.songs?.data ?? [];
  const candidates: AppleSongCandidate[] = songs
    .map((song) => ({
      id: song.id ?? "",
      name: song.attributes?.name ?? "",
      artistName: song.attributes?.artistName ?? "",
      durationMs: Number(song.attributes?.durationInMillis ?? 0),
    }))
    .filter((song) => song.id && song.name);

  const match = pickBestAppleCandidate(spotifyTrack, candidates);
  logInfo("apple-search", "Apple search completed", {
    candidateCount: candidates.length,
    matchedSongId: match?.id ?? null,
    matchedSongName: match?.name ?? null,
  });
  if (match) return match.id;

  logWarn("apple-search", "No confident Apple catalog match; trying iTunes fallback", {
    spotifyTrackId: spotifyTrack.id,
  });
  return await searchWithItunes();
}

async function askAppleForLyrics(params: {
  songId?: string;
  storefront?: string;
  developerToken?: string;
  authorization?: string;
  userToken?: string;
}): Promise<{ httpStatus: number; data: unknown }> {
  const { songId, storefront = "gb" } = params;

  if (!songId) {
    return {
      httpStatus: 400,
      data: { message: "Missing Apple Music song id." },
    };
  }

  const mainToken =
    params.authorization ||
    params.developerToken ||
    process.env.APPLE_AUTHORIZATION ||
    process.env.APPLE_MUSIC_DEVELOPER_TOKEN ||
    "";
  const userToken = params.userToken || process.env.APPLE_MEDIA_USER_TOKEN || process.env.APPLE_MUSIC_USER_TOKEN || "";

  if (!mainToken) {
    return {
      httpStatus: 401,
      data: {
        message: "Missing Apple Music developer token. Provide appleDeveloperToken or APPLE_MUSIC_DEVELOPER_TOKEN.",
      },
    };
  }

  logInfo("apple-lyrics", "Starting Apple lyrics lookup", {
    songId,
    storefront,
    hasAuthorization: Boolean(mainToken),
    hasUserToken: Boolean(userToken),
  });

  const url = `https://amp-api.music.apple.com/v1/catalog/${storefront}/songs/${songId}/syllable-lyrics?l%5Blyrics%5D=en-gb&l%5Bscript%5D=en-Latn&extend=ttmlLocalizations`;
  const headers: Record<string, string> = {
    Authorization: mainToken.startsWith("Bearer ") ? mainToken : `Bearer ${mainToken}`,
    accept: "*/*",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
    origin: "https://music.apple.com",
    referer: "https://music.apple.com/",
    "sec-ch-ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
  };

  if (userToken) {
    headers["media-user-token"] = userToken;
  }

  const result = await fetchJsonWithFallback(url, {
    method: "GET",
    headers,
  });

  if (!result.ok) {
    logWarn("apple-lyrics", "Apple lyrics lookup failed", {
      songId,
      storefront,
      status: result.status,
    });
    return {
      httpStatus: result.status,
      data: result.data,
    };
  }

  if (typeof result.data !== "object" || result.data === null) {
    logWarn("apple-lyrics", "Apple lyrics lookup returned non-object response", {
      songId,
      storefront,
      status: result.status,
      data: result.data,
    });
    return {
      httpStatus: result.status,
      data: result.data,
    };
  }

  const payload = result.data as {
    data?: Array<unknown>;
  };

  if (!Array.isArray(payload.data) || payload.data.length === 0) {
    logWarn("apple-lyrics", "Apple lyrics lookup returned empty data array", {
      songId,
      storefront,
      status: result.status,
      data: result.data,
    });
    return {
      httpStatus: result.status,
      data: result.data,
    };
  }

  logInfo("apple-lyrics", "Apple lyrics raw response", {
    songId,
    storefront,
    status: result.status,
    hasDataArray: Array.isArray(payload.data),
    firstItemType: typeof payload.data?.[0],
  });

  return {
    httpStatus: result.status,
    data: result.data,
  };
}

async function handleQueryOperation(query: QueryInput, carrier: HeaderCarrier): Promise<QueryResult> {
  const operation = query.operation;
  const variables = query.variables ?? {};

  logInfo("query", "Handling query operation", {
    operation,
    variables: summarizeBody(variables),
  });

  if (operation === "lyrics") {
    const trackId = variables.id || variables.trackId;
    const spotifyToken = pickAuthTokenFromQuery(variables, carrier);
    const appleStorefront = variables.appleStorefront || variables.storefront || "gb";
    const appleAuth = resolveAppleAuth({
      carrier,
      developerToken: variables.appleDeveloperToken,
      userToken: variables.appleUserToken,
    });

    let appleSongId = variables.appleSongId;
    if (!appleSongId && trackId) {
      // Use metadata the client already has; only fall back to API if missing
      const clientMeta: SpotifyTrackMeta | null =
        variables.trackName
          ? {
              id: trackId,
              name: variables.trackName,
              artists: Array.isArray(variables.trackArtists) ? variables.trackArtists : [],
              durationMs: Number(variables.trackDurationMs ?? 0),
            }
          : await getSpotifyTrackMeta({ trackId, authorization: spotifyToken });

      if (clientMeta) {
        logInfo("query", "Resolved track metadata for Apple mapping", {
          trackId,
          name: clientMeta.name,
          artists: clientMeta.artists,
          fromClient: Boolean(variables.trackName),
        });
        appleSongId =
          (await searchAppleSongFromSpotifyTrack({
            spotifyTrack: clientMeta,
            storefront: appleStorefront,
            authorization: appleAuth.authorization,
            userToken: appleAuth.userToken || undefined,
          })) ?? undefined;

        logInfo("query", "Spotify to Apple mapping result", {
          trackId,
          mappedAppleSongId: appleSongId ?? null,
        });
      } else {
        logWarn("query", "Could not resolve track metadata for Apple mapping", {
          trackId,
        });
      }
    }

    if (!appleSongId) {
      logWarn("query", "Apple lyrics branch skipped because no Apple song id was resolved", {
        operation,
        trackId,
      });
    }

    if (appleSongId) {
      const appleResult = await askAppleForLyrics({
        songId: appleSongId,
        storefront: appleStorefront,
        authorization: appleAuth.authorization,
        userToken: appleAuth.userToken || undefined,
      });

      if (appleResult.httpStatus === 200) {
        const transformedApple = transformAppleToSpicyLyrics(appleResult.data, trackId || appleSongId);
        if (transformedApple) {
          const wordByWord = isAppleWordByWord(appleResult.data);
          logInfo("query", "Returning Apple lyrics result", {
            operation,
            appleSongId,
            lineCount: transformedApple.Content.length,
            wordByWord,
          });
          return {
            data: transformedApple,
            httpStatus: 200,
            format: "json",
          };
        }

        logWarn("query", "Apple returned 200 but payload could not be transformed", {
          operation,
          appleSongId,
        });
      }

      logWarn("query", "Apple lyrics unavailable, falling back to Spotify", {
        operation,
        appleSongId,
        appleStatus: appleResult.httpStatus,
      });
    }

    const spotifyResult = await askSpotifyForLyrics({
      trackId,
      market: variables.market || "from_token",
      authorization: spotifyToken,
    });

    if (spotifyResult.httpStatus === 200) {
      const transformedSpotify = transformSpotifyToSpicyLyrics(spotifyResult.data, trackId);
      logInfo("query", "Returning Spotify fallback lyrics", {
        operation,
        trackId,
        lineCount: transformedSpotify.Content.length,
      });
      return {
        data: transformedSpotify,
        httpStatus: spotifyResult.httpStatus,
        format: "json",
      };
    }

    logWarn("query", "Spotify lyrics lookup failed", {
      operation,
      trackId,
      status: spotifyResult.httpStatus,
    });

    return {
      data: spotifyResult.data,
      httpStatus: spotifyResult.httpStatus,
      format: "json",
    };
  }

  if (operation === "spotifyLyrics") {
    const trackId = variables.id || variables.trackId;
    const spotifyResult = await askSpotifyForLyrics({
      trackId,
      market: variables.market || "from_token",
      authorization: pickAuthTokenFromQuery(variables, carrier),
    });

    if (spotifyResult.httpStatus === 200) {
      const transformedSpotify = transformSpotifyToSpicyLyrics(spotifyResult.data, trackId);
      logInfo("query", "Returning Spotify-only lyrics", {
        operation,
        trackId,
        lineCount: transformedSpotify.Content.length,
      });
      return {
        data: transformedSpotify,
        httpStatus: spotifyResult.httpStatus,
        format: "json",
      };
    }

    return {
      data: spotifyResult.data,
      httpStatus: spotifyResult.httpStatus,
      format: "json",
    };
  }

  if (operation === "appleLyrics") {
    const appleAuth = resolveAppleAuth({
      carrier,
      developerToken: variables.appleDeveloperToken,
      userToken: variables.appleUserToken,
    });

    const appleResult = await askAppleForLyrics({
      songId: variables.songId || variables.id,
      storefront: variables.storefront || "us",
      authorization: appleAuth.authorization,
      userToken: appleAuth.userToken || undefined,
    });

    const transformedApple = appleResult.httpStatus === 200
      ? transformAppleToSpicyLyrics(appleResult.data, variables.songId || variables.id)
      : null;

    if (transformedApple) {
      const wordByWord = isAppleWordByWord(appleResult.data);
      logInfo("query", "Returning Apple-only transformed lyrics", {
        operation,
        songId: variables.songId || variables.id,
        lineCount: transformedApple.Content.length,
        wordByWord,
      });
      return {
        data: transformedApple,
        httpStatus: appleResult.httpStatus,
        format: "json",
      };
    }

    logWarn("query", "Apple-only lyrics request not transformed", {
      operation,
      status: appleResult.httpStatus,
      songId: variables.songId || variables.id,
    });

    return {
      data: appleResult.data,
      httpStatus: appleResult.httpStatus,
      format: "json",
    };
  }

  return {
    data: { message: `Unsupported operation: ${String(operation)}` },
    httpStatus: 400,
    format: "json",
  };
}

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

app.post("/spotify/lyrics", async (req: Request<unknown, unknown, SpotifyLyricsRequest>, res: Response) => {
  try {
    const trackId = req.body?.trackId;
    const result = await askSpotifyForLyrics({
      trackId,
      market: req.body?.market || "from_token",
      authorization: pickAuthTokenFromQuery({}, req),
    });

    logInfo("route", "POST /spotify/lyrics result", {
      trackId,
      status: result.httpStatus,
    });

    res
      .status(result.httpStatus)
      .json(result.httpStatus === 200 ? transformSpotifyToSpicyLyrics(result.data, trackId) : result.data);
  } catch (error) {
    logError("route", "POST /spotify/lyrics failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      message: "Internal server error while requesting Spotify lyrics.",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/apple/lyrics", async (req: Request<unknown, unknown, AppleLyricsRequest>, res: Response) => {
  try {
    const appleAuth = resolveAppleAuth({
      carrier: req,
      developerToken: req.body?.appleDeveloperToken,
      authorization: req.body?.authorization,
      userToken: req.body?.appleUserToken || req.body?.mediaUserToken,
    });

    const result = await askAppleForLyrics({
      songId: req.body?.songId,
      storefront: req.body?.storefront || "us",
      authorization: appleAuth.authorization,
      userToken: appleAuth.userToken || undefined,
    });

    const transformed = result.httpStatus === 200 ? transformAppleToSpicyLyrics(result.data, req.body?.songId) : null;
    const wordByWord = transformed ? isAppleWordByWord(result.data) : false;

    logInfo("route", "POST /apple/lyrics result", {
      songId: req.body?.songId,
      status: result.httpStatus,
      transformed: Boolean(transformed),
      transformedLines: transformed?.Content.length ?? 0,
      wordByWord,
    });

    res.status(result.httpStatus).json(transformed ?? result.data);
  } catch (error) {
    logError("route", "POST /apple/lyrics failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      message: "Internal server error while requesting Apple lyrics.",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/query", async (req: Request<{}, unknown, { queries?: QueryInput[] }>, res: Response) => {
  try {
    const body = req.body as { queries?: QueryInput[] };
    const queries = Array.isArray(body?.queries) ? body.queries : [];

    logInfo("route", "POST /query processing batch", {
      queryCount: queries.length,
    });

    const results: QueryResponseItem[] = await Promise.all(
      queries.map(async (query, index) => {
        const result = await handleQueryOperation(query, req);

        return {
          operation: query?.operation || "",
          operationId: String(index),
          result,
        };
      })
    );

    res.status(200).json({ queries: results });
  } catch (error) {
    logError("route", "POST /query failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      message: "Internal server error while processing query.",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.listen(PORT, () => {
  logInfo("startup", `Spicy Lyrics Backend listening on http://localhost:${PORT}`, {
    backendLoggingEnabled: LOG_ENABLED,
  });
});
