import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  ArrowLeft,
  Bookmark,
  ChevronLeft,
  Languages,
  List,
  Loader2,
  Sparkles,
  Type,
} from "lucide-react";
import Button from "../components/ui/Button";
import IconButton from "../components/ui/IconButton";
import WindowControls from "../components/WindowControls";
import AiPanel, { type AiQuoteContext } from "../components/AiPanel";
import BookmarksPanel from "../components/BookmarksPanel";
import ReaderBottomPills from "../components/ReaderBottomPills";
import ReaderSettings, {
  getFontFamily,
  getStoredReaderSettings,
  getThemeStyles,
  nudgeFontSize,
  type ReaderSettingsState,
  type ReaderTheme,
} from "../components/ReaderSettings";
import ReaderContextMenu from "../components/ReaderContextMenu";
import HighlightToolbar from "../components/HighlightToolbar";
import ExplainSelectionPopover from "../components/ExplainSelectionPopover";
import DictionaryPanel from "../components/DictionaryPanel";
import type { SelectionClassification } from "../utils/selectionRouting";
import TranslationPopover from "../components/TranslationPopover";
import TableOfContents from "../components/TableOfContents";
import { getBook, updateBookStatus, updateReadingProgress, type Book } from "../hooks/useBooks";
import { getAllSettings } from "../hooks/useSettings";
import type { Highlight } from "../hooks/useBookmarks";
import {
  convertFileSrc,
  emitTo,
  focusWindow,
  getCurrentWindowLabel,
  getInitialReaderTheme,
  invoke,
  listenCurrentWindow,
  onWindowResized,
  setWindowBackgroundColor,
  setWindowTitle,
} from "../platform";
import {
  parseReaderNavigation,
  READER_NAVIGATE_EVENT,
  type ReaderWindowOptions,
} from "../utils/openReaderWindow";
import { extractRangeSelectionContext } from "../utils/aiStream";
import {
  createSavedItemPageResolver,
  getPageInfoFromRelocate,
  resolvePdfPageFromCfi,
  resolveQuotedPage,
  type ResolveSavedItemPages,
  type SavedItemPageResolvedCfi,
} from "../utils/savedItemPages";
import {
  handleAppZoomShortcut,
  refreshAppZoom,
  zoomShortcutActionForEvent,
} from "../lib/appZoom";
import {
  isMacOS,
  isWindows,
  MAC_TRAFFIC_LIGHT_SPACER_CLASS,
} from "../lib/platformEnv";
import { createAnnotationDrawCallback } from "../lib/highlightPalette";
import {
  canShowDualIslands,
  READER_SHELL_BG_BY_THEME,
  readerShellClassForTheme,
  WORKSPACE_PADDING_X,
} from "../lib/readerLayout";

// foliate-js <foliate-view> web component interface
/* eslint-disable @typescript-eslint/no-explicit-any -- foliate-js has no TS definitions */
interface FoliateView extends HTMLElement {
  open(file: string | File | Blob): Promise<void>;
  init(opts: { lastLocation?: string; showTextStart?: boolean }): Promise<void>;
  goTo(target: string | number): Promise<any>;
  prev(): Promise<void>;
  next(): Promise<void>;
  close(): void;
  book: any;
  renderer: any;
  lastLocation: any;
  history: { back(): void; forward(): void; canGoBack: boolean; canGoForward: boolean; addEventListener: EventTarget["addEventListener"]; removeEventListener: EventTarget["removeEventListener"] };
  getCFI(index: number, range: Range): string;
  resolveCFI(cfi: string): SavedItemPageResolvedCfi | null | undefined;
  getLocationOf(index: number, fraction?: number): { current: number; next?: number; total: number } | null;
  addAnnotation(annotation: { value: string; color?: string }): Promise<any>;
  deleteAnnotation(annotation: { value: string }): Promise<void>;
  deselect(): void;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export type PdfOverlay = { layers: React.CSSProperties[] } | null;

function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.replace(/^#/, "");
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

// Pre-divide ink by (1 - page) per sRGB channel so screen(page) lands black glyphs on `text` and white pages on `page`.
function darkPdfInkColor(pageHex: string, textHex: string): string {
  const page = parseHexRgb(pageHex);
  const text = parseHexRgb(textHex);
  return `#${page
    .map((p, i) => {
      const denom = 255 - p;
      const channel = denom <= 0 ? 0 : ((text[i] - p) / denom) * 255;
      return Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

export function getPdfOverlays(theme: string): PdfOverlay {
  switch (theme) {
    case "paper": return { layers: [{
      backgroundColor: getThemeStyles("paper").body,
      mixBlendMode: "multiply",
    }] };
    case "quiet": return { layers: [{
      backgroundColor: getThemeStyles("quiet").body,
      mixBlendMode: "multiply",
    }] };
    case "dark": {
      const dark = getThemeStyles("dark");
      return { layers: [
        { backgroundColor: "#ffffff", mixBlendMode: "difference" },
        { backgroundColor: darkPdfInkColor(dark.body, dark.text), mixBlendMode: "multiply" },
        { backgroundColor: dark.body, mixBlendMode: "screen" },
      ] };
    }
    default: return null;
  }
}

// PDF pages render as black ink on white beneath getPdfOverlays, which recolour the thumb with them.
export function getReaderScrollbarVars(format: string, theme: ReaderTheme): Record<string, string> {
  const ink = format === "pdf" ? "#000000" : getThemeStyles(theme).text;
  return { "--scrollbar-thumb": `${ink}33`, "--scrollbar-thumb-hover": `${ink}55` };
}

let cachedLiterataFontCss: string | null = null;

function getLiterataFontFaceCSS(): string {
  if (cachedLiterataFontCss !== null) return cachedLiterataFontCss;
  const rules: string[] = [];
  try {
    for (const sheet of Array.from(document.styleSheets)) {
      let cssRules: CSSRuleList;
      try {
        cssRules = sheet.cssRules;
      } catch {
        continue;
      }
      const baseHref = sheet.href || document.baseURI;
      for (const rule of Array.from(cssRules)) {
        if (typeof CSSFontFaceRule !== "undefined" && rule instanceof CSSFontFaceRule) {
          const family = rule.style.getPropertyValue("font-family");
          if (family.includes("Literata")) {
            const rewritten = rule.cssText.replace(
              /url\((['"]?)([^'")]+)\1\)/g,
              (_match, _quote, url: string) => {
                try {
                  return `url("${new URL(url, baseHref).href}")`;
                } catch {
                  return `url("${url}")`;
                }
              },
            );
            rules.push(rewritten);
          }
        }
      }
    }
  } catch {
    // Fallback to Georgia if stylesheet inspection is unavailable
  }
  cachedLiterataFontCss = rules.join("\n");
  return cachedLiterataFontCss;
}

const getReaderCSS = (settings: ReaderSettingsState) => {
  const themeColors = getThemeStyles(settings.theme);
  const fontFamily = getFontFamily(settings.font);
  const fontFaceCSS = settings.font === "literata" ? getLiterataFontFaceCSS() : "";
  const letterSpacing = settings.charSpacing === 0 ? "normal" : `${settings.charSpacing * 0.01}em`;
  const wordSpacing = settings.wordSpacing === 0 ? "normal" : `${settings.wordSpacing * 0.01}em`;
  // The book's iframe cannot see Quill's CSS variables, so this repeats the
  // --color-focus-ring values for light and dark pages.
  const focusRing = settings.theme === "dark" ? "rgba(161, 147, 245, 0.5)" : "rgba(111, 99, 210, 0.4)";
  const colorScheme = settings.theme === "dark" ? "dark" : "light";
  const scrollbarCSS = `
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track,
    ::-webkit-scrollbar-corner { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background-color: ${themeColors.text}33;
      border: 2px solid transparent;
      background-clip: content-box;
      border-radius: 9999px;
    }
    ::-webkit-scrollbar-thumb:hover,
    ::-webkit-scrollbar-thumb:active { background-color: ${themeColors.text}55; }
  `;
  return `
    ${fontFaceCSS}
    :root {
      color-scheme: ${colorScheme};
    }
    :focus-visible {
      outline: 3px solid ${focusRing} !important;
      outline-offset: 0 !important;
    }
    body {
      background-color: ${themeColors.body} !important;
      color: ${themeColors.text} !important;
      font-family: ${fontFamily} !important;
      font-size: ${settings.fontSize}px !important;
      line-height: ${settings.lineSpacing} !important;
      letter-spacing: ${letterSpacing} !important;
      word-spacing: ${wordSpacing} !important;
    }
    p, span, div, li, td, th, h1, h2, h3, h4, h5, h6 {
      color: ${themeColors.text} !important;
      font-family: ${fontFamily} !important;
      line-height: ${settings.lineSpacing} !important;
    }
    ${scrollbarCSS}
    img, svg, video {
      max-width: 100% !important;
      height: auto !important;
      object-fit: contain !important;
      box-sizing: border-box !important;
    }
    figure {
      max-width: 100% !important;
      overflow: hidden !important;
    }
  `;
};

const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 700;
const PANEL_DEFAULT_WIDTH = 420;

type SidePanel = "ai" | "bookmarks" | "vocab" | null;

interface TocChapter {
  title: string;
  breadcrumb?: string;
  href?: string;
  targetHref?: string;
  depth: number;
}

const windowLabel = getCurrentWindowLabel();
const isMainWindow = windowLabel === "main";
const isStandaloneWindow = windowLabel.startsWith("reader-");

function normalizeReaderTheme(theme: unknown): ReaderTheme | null {
  if (
    theme === "original" ||
    theme === "paper" ||
    theme === "quiet" ||
    theme === "dark"
  ) {
    return theme;
  }
  return null;
}

function readInitialBookTheme(bookId: string | undefined): ReaderTheme {
  if (bookId) {
    try {
      const raw = localStorage.getItem(`reader-settings-${bookId}`);
      if (raw) {
        const parsed = JSON.parse(raw) as { theme?: unknown };
        const override = normalizeReaderTheme(parsed.theme);
        if (override) return override;
      }
    } catch {
      // Ignore malformed localStorage state
    }
  }
  return normalizeReaderTheme(getInitialReaderTheme()) ?? "original";
}

// One-time migration of `reader-zoom-${bookId}` keys written by PR #199.
// That PR saved "100" on every default open, so every pre-upgrade book has
// it even when the user never touched zoom. Under the new scheme, the
// default is "fit" and "100" should mean the user explicitly chose 100%.
// Rewrite legacy "100" → "fit" once, guarded by a global marker so new
// explicit 100% saves aren't clobbered on subsequent opens.
(() => {
  try {
    if (localStorage.getItem("reader-zoom-v2")) return;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith("reader-zoom-") && localStorage.getItem(k) === "100") {
        localStorage.setItem(k, "fit");
      }
    }
    localStorage.setItem("reader-zoom-v2", "1");
  } catch { /* private-mode storage failures are non-fatal */ }
})();

// Synthesize a foliate "fake" CFI for a PDF section index so legacy books
// without a saved CFI (only `progress`) still restore to the right page.
// Mirrors `CFI.fake.fromIndex` in epubcfi.js. Returning a CFI string (not a
// number) ensures `view.init` treats page 0 as present — it checks
// `lastLocation ? ...` and numeric 0 would be seen as absent.
function getPdfStartCfi(progress: number, pageCount: number | null | undefined): string | undefined {
  if (!Number.isFinite(progress) || progress <= 0 || !pageCount || pageCount <= 0) return undefined;
  const idx = Math.min(pageCount - 1, Math.max(0, Math.ceil((progress / 100) * pageCount) - 1));
  return `epubcfi(/6/${(idx + 1) * 2})`;
}

export default function Reader() {
  const { bookId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const isMac = isMacOS();
  const isWin = isWindows();
  const [book, setBook] = useState<Book | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidePanel, setSidePanel] = useState<SidePanel>(null);
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT_WIDTH);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [tocOpen, setTocOpen] = useState(false);
  const [chapters, setChapters] = useState<TocChapter[]>([]);
  const [currentChapterIndex, setCurrentChapterIndex] = useState(-1);
  const [progress, setProgress] = useState(0);
  const [pageInfo, setPageInfo] = useState<{ current: number; total: number } | null>(null);
  const [pdfSpreadRange, setPdfSpreadRange] = useState<{ start: number; end: number } | null>(null);
  const [resolveSavedItemPages, setResolveSavedItemPages] = useState<ResolveSavedItemPages | undefined>(undefined);
  const [timeLeftMinutes, setTimeLeftMinutes] = useState<number | null>(null);
  const currentCfiRef = useRef<string | null>(null);
  const [currentCfi, setCurrentCfi] = useState<string | null>(null);
  const [bookReady, setBookReady] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [jumpBackPage, setJumpBackPage] = useState<number | null>(null);
  const backButtonTimerRef = useRef<number | null>(null);
  const currentPageNumRef = useRef<number | null>(null);
  const backPageStackRef = useRef<number[]>([]);
  const forwardPageStackRef = useRef<number[]>([]);
  const pendingHistoryActionRef = useRef<"back" | "forward" | null>(null);
  const pendingJumpFromPageRef = useRef<number | null>(null);
  const [initError, setInitError] = useState(false);
  const [highlightVersion, setHighlightVersion] = useState(0);
  const [vocabVersion, setVocabVersion] = useState(0);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    text: string;
    sentence: string;
    sentenceOffset?: number;
    cfiRange?: string;
    sectionIndex?: number;
  } | null>(null);
  const [aiContext, setAiContext] = useState<AiQuoteContext | undefined>();
  const [initialChatNav, setInitialChatNav] = useState<{ chatId?: string; seq: number }>({ seq: 0 });
  const chatNavSeqRef = useRef(0);
  const [selectionPopover, setSelectionPopover] = useState<{
    x: number;
    y: number;
    text: string;
    sentence: string;
    bookTitle?: string;
    chapter?: string;
    cfi?: string;
    sectionIndex?: number;
    classification: SelectionClassification;
  } | null>(null);
  const [translation, setTranslation] = useState<{
    x: number;
    y: number;
    text: string;
    context?: string;
    contextOffset?: number;
    cfi?: string;
  } | null>(null);
  const [highlightToolbar, setHighlightToolbar] = useState<{
    x: number;
    y: number;
    highlightId: string;
    cfiRange: string;
    color: string;
    text: string | null;
    sectionIndex?: number;
  } | null>(null);
  const [readerSettings, setReaderSettings] = useState<ReaderSettingsState>(() => ({
    theme: readInitialBookTheme(bookId),
    font: "literata",
    fontSize: 26,
    brightness: 100,
    readingMode: "scrolling",
    pageColumns: 2,
    lineSpacing: 1.8,
    charSpacing: 0,
    wordSpacing: 0,
    margins: 0,
  }));
  const [hasFontSizeOverride, setHasFontSizeOverride] = useState(false);

  const settingsAnchorRef = useRef<HTMLButtonElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateView | null>(null);
  const isDragging = useRef(false);
  const readerSettingsRef = useRef(readerSettings);
  readerSettingsRef.current = readerSettings;
  const globalFontSizeRef = useRef(readerSettings.fontSize);
  const chaptersRef = useRef<TocChapter[]>([]);
  const selectedTextRef = useRef<{ text: string; cfi: string } | null>(null);
  const [workspaceInnerWidth, setWorkspaceInnerWidth] = useState(() =>
    typeof window !== "undefined" ? Math.max(0, window.innerWidth - WORKSPACE_PADDING_X) : 1400,
  );
  const tocChapters = useMemo(() => chapters.map((chapter, i) => ({
    title: chapter.title,
    page: i + 1,
    depth: chapter.depth,
    disabled: !chapter.targetHref,
  })), [chapters]);

  // Reader shell follows the page theme, not the app theme:
  // Original/Sepia/Gray use Dawn light tokens; Dark activates Nocturne (.dawn.dark).
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.add("dawn");
    root.dataset.readerTheme = readerSettings.theme;
    root.classList.toggle("dark", readerSettings.theme === "dark");
    if (isStandaloneWindow) {
      void setWindowBackgroundColor(READER_SHELL_BG_BY_THEME[readerSettings.theme]).catch(() => {});
    }
  }, [readerSettings.theme]);

  useEffect(() => {
    return () => {
      const root = document.documentElement;
      delete root.dataset.readerTheme;
      if (!isMainWindow) {
        root.classList.remove("dark");
      }
    };
  }, []);

  useEffect(() => {
    const measure = () => {
      const el = workspaceRef.current;
      const inner = el
        ? el.clientWidth - WORKSPACE_PADDING_X
        : window.innerWidth - WORKSPACE_PADDING_X;
      setWorkspaceInnerWidth(Math.max(0, inner));
    };
    measure();
    const ro = workspaceRef.current ? new ResizeObserver(measure) : null;
    if (workspaceRef.current && ro) {
      ro.observe(workspaceRef.current);
    }
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [loading, book?.id]);

  // Load book metadata and default settings from DB
  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
    getBook(bookId)
      .then((b) => {
        if (cancelled) return;
        if (b && b.status === "unread") {
          setBook({ ...b, status: "reading" });
          void updateBookStatus(b.id, "reading")
            .then(() => {
              if (isStandaloneWindow) {
                void emitTo("main", "book-status-changed", b.id).catch(() => {});
              }
            })
            .catch(() => {
              if (!cancelled) {
                setBook((prev) => (prev?.id === b.id ? { ...prev, status: "unread" } : prev));
              }
            });
        } else {
          setBook(b);
        }
        if (isStandaloneWindow && b) {
          void setWindowTitle(b.title);
        }
      })
      .catch(() => {
        if (!cancelled) setBook(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    getAllSettings().then((globalSettings) => {
      if (cancelled) return;
      const saved = localStorage.getItem(`reader-settings-${bookId}`);
      const bookSettings = saved ? JSON.parse(saved) as Partial<ReaderSettingsState> : {};
      const g = globalSettings;
      const globalFontSize = g.font_size ? parseInt(g.font_size) : readerSettingsRef.current.fontSize;
      globalFontSizeRef.current = globalFontSize;
      setHasFontSizeOverride(bookSettings.fontSize !== undefined);
      setReaderSettings((prev) => ({
        ...prev,
        theme: bookSettings.theme || (g.reader_theme as ReaderSettingsState["theme"]) || prev.theme,
        brightness: bookSettings.brightness ?? (g.brightness ? parseInt(g.brightness) : prev.brightness),
        pageColumns: bookSettings.pageColumns ?? (g.page_columns ? parseInt(g.page_columns) as ReaderSettingsState["pageColumns"] : prev.pageColumns),
        font: bookSettings.font || (g.font_family as ReaderSettingsState["font"]) || prev.font,
        fontSize: bookSettings.fontSize ?? globalFontSize,
        readingMode: bookSettings.readingMode || (g.reading_mode as ReaderSettingsState["readingMode"]) || prev.readingMode,
        lineSpacing: bookSettings.lineSpacing ?? (g.line_spacing ? parseFloat(g.line_spacing) : prev.lineSpacing),
        charSpacing: bookSettings.charSpacing ?? (g.char_spacing ? parseInt(g.char_spacing) : prev.charSpacing),
        wordSpacing: bookSettings.wordSpacing ?? (g.word_spacing ? parseInt(g.word_spacing) : prev.wordSpacing),
        margins: bookSettings.margins ?? (g.margins ? parseInt(g.margins) : prev.margins),
      }));
      const savedZoom = localStorage.getItem(`reader-zoom-${bookId}`);
      if (savedZoom === "fit") {
        setZoom("fit");
      } else {
        const parsedZoom = savedZoom ? parseInt(savedZoom, 10) : NaN;
        if (Number.isFinite(parsedZoom) && parsedZoom >= 50 && parsedZoom <= 300) {
          setZoom(parsedZoom);
        }
      }
      dbSettingsLoaded.current = true;
    }).catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [bookId]);

  // Persist reader settings to localStorage when they change — only after load completes
  // to avoid overwriting saved values with defaults during initialization
  const dbSettingsLoaded = useRef(false);
  useEffect(() => {
    if (!dbSettingsLoaded.current) return;
    const storedSettings = getStoredReaderSettings(readerSettings, hasFontSizeOverride);
    localStorage.setItem(`reader-settings-${bookId}`, JSON.stringify(storedSettings));
  }, [readerSettings, bookId, hasFontSizeOverride]);

  // Persist per-book PDF zoom after load. Debounce to avoid thrashing during
  // rapid zoom-button clicks; only write once the user settles.
  useEffect(() => {
    if (!dbSettingsLoaded.current) return;
    if (book?.format !== "pdf") return;
    const handle = window.setTimeout(() => {
      localStorage.setItem(`reader-zoom-${bookId}`, zoom === "fit" ? "fit" : String(zoom));
    }, 500);
    return () => window.clearTimeout(handle);
  }, [zoom, bookId, book?.format]);

  // Persist per-book reader window size. Standalone reader windows are
  // labelled `reader-${bookId}`; openReaderWindow reads this key back on
  // next open so the window restores to the size the user left it at.
  useEffect(() => {
    if (!isStandaloneWindow || !bookId) return;
    let timer: number | null = null;
    const unlistenPromise = onWindowResized((logical) => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        try {
          localStorage.setItem(
            `reader-window-${bookId}`,
            JSON.stringify({ width: Math.round(logical.width), height: Math.round(logical.height) }),
          );
        } catch { /* window may have closed */ }
      }, 500);
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, [bookId]);

  const goBackInHistory = useCallback(() => {
    if (!viewRef.current?.history.canGoBack) return;
    pendingHistoryActionRef.current = "back";
    viewRef.current.history.back();
  }, []);

  const goForwardInHistory = useCallback(() => {
    if (!viewRef.current?.history.canGoForward) return;
    pendingHistoryActionRef.current = "forward";
    viewRef.current.history.forward();
  }, []);

  const handleToolbarLibraryClick = useCallback(() => {
    if (isStandaloneWindow) {
      void focusWindow("main");
    } else {
      navigate("/");
    }
  }, [navigate]);

  const handleBackToLibrary = useCallback(() => {
    if (isStandaloneWindow) {
      void focusWindow("main").finally(() => window.close());
    } else {
      navigate("/");
    }
  }, [navigate]);

  const handleOpenInWords = useCallback(
    (wordId?: string) => {
      if (isStandaloneWindow) {
        void emitTo("main", "navigate-main-route", {
          route: "words",
          wordId: wordId ?? null,
        });
        void focusWindow("main");
      } else {
        const params = new URLSearchParams({ route: "words" });
        if (wordId) params.set("wordId", wordId);
        navigate(`/?${params.toString()}`);
      }
    },
    [navigate],
  );

  // Initialize foliate-js when book data is loaded
  useEffect(() => {
    if (!book || !viewerRef.current) return;

    const container = viewerRef.current;
    container.innerHTML = "";
    setBookReady(false);
    setResolveSavedItemPages(undefined);

    if (book.available === false) {
      setInitError(true);
      return;
    }

    setInitError(false);

    let cancelled = false;
    let effectView: FoliateView | null = null;

    const disposeEffectView = () => {
      const target = effectView;
      if (!target) return;
      if (viewRef.current === target) {
        viewRef.current = null;
      }
      try {
        target.close?.();
      } catch {
        // Uninitialized foliate-view has no renderer yet.
      }
      target.remove();
    };

    const initFoliate = async () => {
      // Load foliate-js web components (from public/ dir, loaded as native ES module)
      if (!customElements.get("foliate-view")) {
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement("script");
          script.type = "module";
          script.src = "/foliate-js/view.js";
          script.onload = () => resolve();
          script.onerror = () => reject(new Error("Failed to load foliate-js"));
          document.head.appendChild(script);
        });
        // Wait for custom element to be defined
        await customElements.whenDefined("foliate-view");
      }

      if (cancelled) return;

      // Fetch EPUB/PDF as blob before attaching foliate-view so a missing or
      // unreadable file never leaves a partial element mounted.
      const fileUrl = convertFileSrc(book.file_path);
      const response = await fetch(fileUrl);
      if (response.ok === false) {
        throw new Error(`Failed to fetch book file (${response.status})`);
      }
      const ext = book.format === "pdf" ? "pdf" : "epub";
      const blob = new File([await response.blob()], `book.${ext}`);

      if (cancelled) return;

      const view = document.createElement("foliate-view") as FoliateView;
      view.style.display = "block";
      view.style.width = "100%";
      view.style.height = "100%";
      // Opt into the continuous-scroll PDF renderer before open(); view.js
      // branches its internal renderer pick on this attribute. EPUBs ignore it.
      if (book.format === "pdf" && readerSettings.readingMode === "scrolling") {
        view.setAttribute("pdf-mode", "scroll");
      }
      effectView = view;
      container.appendChild(view);
      viewRef.current = view;

      await view.open(blob);

      if (cancelled) {
        disposeEffectView();
        return;
      }

      // Set reading mode and layout
      const isScrolling = readerSettings.readingMode === "scrolling";
      view.renderer.setAttribute("flow", isScrolling ? "scrolled" : "paginated");
      view.renderer.setAttribute("gap", "5%");
      view.renderer.setAttribute("max-inline-size", "1000px");
      view.renderer.setAttribute("max-column-count", String(readerSettings.pageColumns));
      // Spread mode for fixed-layout (PDF) — 'none' = single page, default = two pages
      if (book.format === "pdf") {
        view.renderer.setAttribute("spread", readerSettings.pageColumns === 1 ? "none" : "auto");
        // Seed zoom from localStorage BEFORE view.init so CFI restore lands on
        // the right scroll offset. Re-applying after init would trigger a
        // #layoutAll() that invalidates the pixel position for the restored CFI.
        const savedZoom = localStorage.getItem(`reader-zoom-${bookId}`);
        let zoomAttr = "fit-width";
        if (savedZoom && savedZoom !== "fit") {
          const n = parseInt(savedZoom, 10);
          if (Number.isFinite(n) && n >= 50 && n <= 300) zoomAttr = String(n / 100);
        }
        view.renderer.setAttribute("zoom", zoomAttr);
      }

      // Apply styles
      view.renderer.setStyles?.(getReaderCSS(readerSettings));

      // PDF theming is handled by the overlay div in the JSX

      // Load TOC
      const toc = view.book.toc;
      if (toc) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tocHref = (item: any): string | undefined => {
          if (typeof item.href !== "string" || item.href === "" || item.href === "null") return undefined;
          return item.href;
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const firstHref = (item: any): string | undefined => {
          const href = tocHref(item);
          if (href) return href;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return item.subitems?.map((child: any) => firstHref(child)).find(Boolean);
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const flattenToc = (items: any[], depth = 0, parentTitle?: string): TocChapter[] =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          items.flatMap((item: any) => {
            const title = item.label?.trim() || "";
            const breadcrumb = parentTitle && title ? `${parentTitle} · ${title}` : title || parentTitle;
            return [
              { title, breadcrumb, href: tocHref(item), targetHref: firstHref(item), depth },
              ...(item.subitems ? flattenToc(item.subitems, depth + 1, breadcrumb) : []),
            ];
          });
        const chs = flattenToc(toc);
        chaptersRef.current = chs;
        setChapters(chs);
      }

      // Listen for location changes
      view.addEventListener("relocate", ((e: CustomEvent) => {
        const { fraction, location, section, tocItem, cfi, time } = e.detail;

        const pct = Math.round((fraction ?? 0) * 100);
        setProgress(pct);
        currentCfiRef.current = cfi;
        setCurrentCfi(cfi ?? null);

        const remaining =
          typeof time?.total === "number" && Number.isFinite(time.total) && time.total > 0
            ? time.total
            : null;
        setTimeLeftMinutes(remaining);

        const nextPageInfo = getPageInfoFromRelocate({ location, section }, book.format);
        if (nextPageInfo) {
          const { current, total } = nextPageInfo;
          currentPageNumRef.current = current;
          setPageInfo(nextPageInfo);
          if (book.format === "pdf") {
            const { pageColumns, readingMode } = readerSettingsRef.current;
            if (pageColumns === 2) {
              if (readingMode === "paginated" && view.renderer?.getContents) {
                const indices = (view.renderer.getContents() as Array<{ index?: number }>)
                  .map((c) => c.index)
                  .filter((idx): idx is number => typeof idx === "number" && Number.isFinite(idx) && idx >= 0)
                  .sort((a, b) => a - b);
                const unique = Array.from(new Set(indices));
                if (unique.length === 2) {
                  setPdfSpreadRange({ start: unique[0] + 1, end: unique[1] + 1 });
                } else if (unique.length === 1) {
                  setPdfSpreadRange({ start: unique[0] + 1, end: unique[0] + 1 });
                } else {
                  setPdfSpreadRange({ start: current, end: current });
                }
              } else if (readingMode === "scrolling") {
                if (current % 2 === 1 && current < total) {
                  setPdfSpreadRange({ start: current, end: current + 1 });
                } else if (current % 2 === 0 && current > 1) {
                  setPdfSpreadRange({ start: current - 1, end: current });
                } else {
                  setPdfSpreadRange({ start: current, end: current });
                }
              } else {
                setPdfSpreadRange({ start: current, end: current });
              }
            } else {
              setPdfSpreadRange({ start: current, end: current });
            }
          }
        }

        if (tocItem) {
          const exactIdx = chaptersRef.current.findIndex((c) => c.href === tocItem.href);
          const idx = exactIdx !== -1
            ? exactIdx
            : chaptersRef.current.findIndex((c) => c.targetHref === tocItem.href);
          if (idx !== -1) setCurrentChapterIndex(idx);
        }

        if (bookId) {
          updateReadingProgress(bookId, pct, cfi).catch(() => {});
        }
      }) as EventListener);

      view.addEventListener("link", () => {
        pendingJumpFromPageRef.current = currentPageNumRef.current;
      });

      // Track navigation history for back button. Auto-hide 10s after the
      // last jump so it doesn't linger once the reader has settled.
      view.history.addEventListener("index-change", () => {
        const canBack = view.history.canGoBack;
        const action = pendingHistoryActionRef.current;
        pendingHistoryActionRef.current = null;
        if (action === "back") {
          backPageStackRef.current.pop();
          if (currentPageNumRef.current !== null) {
            forwardPageStackRef.current.push(currentPageNumRef.current);
          }
        } else if (action === "forward") {
          forwardPageStackRef.current.pop();
          if (currentPageNumRef.current !== null) {
            backPageStackRef.current.push(currentPageNumRef.current);
          }
        } else if (canBack && pendingJumpFromPageRef.current !== null) {
          backPageStackRef.current.push(pendingJumpFromPageRef.current);
          forwardPageStackRef.current = [];
        }
        pendingJumpFromPageRef.current = null;
        if (!canBack) {
          backPageStackRef.current = [];
        }
        setCanGoBack(canBack);
        setJumpBackPage(backPageStackRef.current[backPageStackRef.current.length - 1] ?? null);
        if (backButtonTimerRef.current !== null) {
          window.clearTimeout(backButtonTimerRef.current);
          backButtonTimerRef.current = null;
        }
        if (canBack) {
          backButtonTimerRef.current = window.setTimeout(() => {
            setCanGoBack(false);
            backButtonTimerRef.current = null;
          }, 10000);
        }
      });

      // Handle section loads — styles, zoom, text selection, keyboard, highlights
      view.addEventListener("load", ((e: CustomEvent) => {
        const { doc, index } = e.detail;
        view.renderer.setStyles?.(getReaderCSS(readerSettingsRef.current));
        if (book.format === "epub") void refreshAppZoom();

        // Text selection tracking
        doc.addEventListener("mouseup", () => {
          const sel = doc.getSelection?.();
          const text = sel?.toString().trim();
          if (text && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            const cfi = view.getCFI(index, range);
            selectedTextRef.current = { text, cfi };
          }
        });

        // Context menu inside content
        // foliate-js renders in iframes; clientX/Y are relative to the
        // iframe viewport. Use frameElement to get the iframe's offset.
        doc.addEventListener("contextmenu", (ev: MouseEvent) => {
          ev.preventDefault();
          const sel = doc.getSelection?.();
          const text = sel?.toString().trim();
          if (text) {
            const iframe = doc.defaultView?.frameElement as HTMLElement | null;
            let offsetX = 0, offsetY = 0;
            if (iframe) {
              const rect = iframe.getBoundingClientRect();
              offsetX = rect.left;
              offsetY = rect.top;
            }
            // Extract surrounding context and CFI from the current DOM Range selection
            let sentence = text;
            let sentenceOffset = 0;
            let currentCfi: string | undefined;
            if (sel.rangeCount > 0) {
              const range = sel.getRangeAt(0);
              try {
                const resolved = view.getCFI(index, range);
                if (resolved) {
                  currentCfi = resolved;
                  selectedTextRef.current = { text, cfi: resolved };
                }
              } catch {
                // Fall back to sentence-based identity when current range CFI is unavailable.
              }
              let node: Node | null = range.startContainer;
              // Walk up to the nearest block-level element
              const blockTags = new Set(["P", "DIV", "LI", "BLOCKQUOTE", "TD", "TH", "H1", "H2", "H3", "H4", "H5", "H6", "SECTION", "ARTICLE", "ASIDE", "FIGCAPTION", "DT", "DD"]);
              while (node && node !== doc.body && !(node.nodeType === 1 && blockTags.has((node as Element).tagName))) {
                node = node.parentNode;
              }
              // Fall back to body if no block element found
              const contextNode = node && node !== doc.body ? node : range.startContainer.parentElement;
              if (contextNode && contextNode.nodeType === 1) {
                const extracted = extractRangeSelectionContext(contextNode as Element, range, text);
                sentence = extracted.sentence;
                sentenceOffset = extracted.matchStart;
              }
            }
            setContextMenu({
              x: ev.clientX + offsetX,
              y: ev.clientY + offsetY,
              text,
              sentence,
              sentenceOffset,
              cfiRange: currentCfi,
              sectionIndex: typeof index === "number" ? index : undefined,
            });
          }
        });

        // Keyboard navigation inside content docs
        doc.addEventListener("keydown", (ev: KeyboardEvent) => {
          if ((ev.metaKey || ev.ctrlKey) && ev.key === "[") {
            ev.preventDefault();
            goBackInHistory();
          } else if ((ev.metaKey || ev.ctrlKey) && ev.key === "]") {
            ev.preventDefault();
            goForwardInHistory();
          } else if (
            isMainWindow
              ? handleAppZoomShortcut(ev)
              : handleReaderZoomShortcut(ev, book.format)
          ) return;
          else if (ev.key === "ArrowLeft") view.prev();
          else if (ev.key === "ArrowRight") view.next();
        });

        // Click to dismiss context menu and highlight toolbar
        doc.addEventListener("click", () => {
          setContextMenu(null);
          setHighlightToolbar(null);
        });

        // Cross-iframe deselect: each PDF page renders in its own iframe
        // with its own Selection object, so clicking on a neighbor page
        // (e.g. the right page in two-page spread mode, or any other page
        // in scroll mode) wouldn't normally clear the selection on the
        // page you came from. Wipe other iframes' selections on mousedown
        // — the current iframe is left alone so the browser can place a
        // fresh caret at the click point.
        doc.addEventListener("mousedown", () => {
          // getContents() lives on the renderer, not the View element.
          const contents = view.renderer?.getContents?.() ?? [];
          for (const { doc: otherDoc } of contents) {
            if (otherDoc && otherDoc !== doc) {
              otherDoc.defaultView?.getSelection()?.removeAllRanges();
            }
          }
          setHighlightToolbar(null);
        });
      }) as EventListener);

      // Highlight overlay system
      view.addEventListener("create-overlay", ((e: CustomEvent) => {
        const { index: _sectionIndex } = e.detail; // eslint-disable-line @typescript-eslint/no-unused-vars
        // Load highlights for this section
        if (bookId) {
          invoke<Highlight[]>("list_highlights", { bookId }).then((hls) => {
            for (const hl of hls) {
              try {
                view.addAnnotation({ value: hl.cfi_range, color: hl.color });
              } catch {
                // Invalid CFI
              }
            }
          }).catch(() => {});
        }
      }) as EventListener);

      view.addEventListener("draw-annotation", ((e: CustomEvent) => {
        const { draw, annotation } = e.detail;
        const isPdf = book?.format === "pdf";
        draw(
          createAnnotationDrawCallback(
            annotation.color,
            () => readerSettingsRef.current.theme,
            isPdf,
          ),
        );
      }) as EventListener);

      view.addEventListener("show-annotation", ((e: CustomEvent) => {
        const { value, index, range } = e.detail;
        // Find the highlight in the DB to get its id and color
        if (bookId) {
          invoke<Highlight[]>("list_highlights", { bookId }).then((hls) => {
            const hl = hls.find((h) => h.cfi_range === value);
            if (hl && range) {
              const rect = range.getBoundingClientRect();
              // The range is inside an iframe, offset to main viewport
              const iframe = range.startContainer?.ownerDocument?.defaultView?.frameElement as HTMLElement | null;
              let offsetX = 0, offsetY = 0;
              if (iframe) {
                const iframeRect = iframe.getBoundingClientRect();
                offsetX = iframeRect.left;
                offsetY = iframeRect.top;
              }
              setHighlightToolbar({
                x: rect.left + offsetX + rect.width / 2,
                y: rect.top + offsetY,
                highlightId: hl.id,
                cfiRange: hl.cfi_range,
                color: hl.color,
                text: hl.text_content ?? null,
                sectionIndex: typeof index === "number" ? index : undefined,
              });
            }
          }).catch(() => {});
        }
      }) as EventListener);

      // Navigate to saved position. Prefer the in-memory cursor (kept fresh
      // by the relocate handler) over the stale `book.current_cfi` from
      // initial load — matters when re-init is triggered by a reading-mode
      // toggle mid-session.
      const startCfi = currentCfiRef.current || book.current_cfi;
      let startLocation: string | undefined = startCfi || undefined;
      if (!startLocation && book.format === "pdf") {
        const pageCount = view.book?.sections?.length ?? book.pages;
        startLocation = getPdfStartCfi(book.progress, pageCount);
      }
      await view.init({ lastLocation: startLocation, showTextStart: !startLocation });

      if (cancelled) {
        disposeEffectView();
        return;
      }

      setResolveSavedItemPages(() => createSavedItemPageResolver(view, book.format));
      setBookReady(true);
    };

    initFoliate().catch((err) => {
      console.error("Failed to initialize foliate-js:", err);
      disposeEffectView();
      if (cancelled) return;
      setInitError(true);
    });

    return () => {
      cancelled = true;
      if (backButtonTimerRef.current !== null) {
        window.clearTimeout(backButtonTimerRef.current);
        backButtonTimerRef.current = null;
      }
      backPageStackRef.current = [];
      forwardPageStackRef.current = [];
      pendingHistoryActionRef.current = null;
      pendingJumpFromPageRef.current = null;
      setCanGoBack(false);
      setJumpBackPage(null);
      setResolveSavedItemPages(undefined);
      disposeEffectView();
    };
    // PDFs need a fresh `view` element when reading mode flips because
    // `pdf-mode="scroll"` is read once inside view.js's renderer pick.
    // EPUBs handle scroll/paginated switching live via the reactive effect
    // below, so the derived dep stays `null` for them and the effect won't
    // re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, book?.format === "pdf" ? readerSettings.readingMode : null]);

  // Apply reader settings reactively
  useEffect(() => {
    const view = viewRef.current;
    if (!view?.renderer) return;

    // Update styles (theme, font, spacing)
    view.renderer.setStyles?.(getReaderCSS(readerSettings));

    // Re-draw highlight overlays so light/dark highlight palettes match paper theme
    const contents = view.renderer.getContents?.() as Array<{ overlayer?: { redraw?: () => void } }> | undefined;
    contents?.forEach((c) => c.overlayer?.redraw?.());

    // Update reading mode — foliate-js supports instant switching
    view.renderer.setAttribute("flow",
      readerSettings.readingMode === "scrolling" ? "scrolled" : "paginated"
    );

    // Update page columns (single page vs two pages)
    view.renderer.setAttribute("max-column-count", String(readerSettings.pageColumns));
    // Spread mode for fixed-layout (PDF)
    if (book?.format === "pdf") {
      view.renderer.setAttribute("spread", readerSettings.pageColumns === 1 ? "none" : "auto");
    }

    // Update max-inline-size for margins (narrower content = more margin)
    const baseWidth = 1000;
    const marginOffset = readerSettings.margins * 2;
    view.renderer.setAttribute("max-inline-size", `${Math.max(400, baseWidth - marginOffset)}px`);

    // Brightness and PDF theming are applied on the Paper viewport and overlay in JSX;
    // bookReady is in deps so this re-runs once foliate finishes init —
    // fixes a race where DB-loaded settings arrive before view.renderer exists.
  }, [readerSettings, book?.format, bookReady]);

  const zoomRef = useRef<number | "fit">(zoom);
  zoomRef.current = zoom;

  // Effective fit-width percentage, updated as the viewer resizes. Used to
  // seed the numeric zoom when the user clicks +/- from fit mode so the
  // transition is smooth (e.g. fit≈1.47 → tap + → 150%, not 110%).
  const fitPctRef = useRef(100);
  const [fitPercent, setFitPercent] = useState(100);

  const applyZoom = useCallback((value: number | "fit") => {
    const renderer = viewRef.current?.renderer;
    if (!renderer) return;
    renderer.setAttribute("zoom", value === "fit" ? "fit-width" : String(value / 100));
  }, []);

  const handleZoom = useCallback((delta: number) => {
    const base = zoomRef.current === "fit" ? fitPctRef.current : zoomRef.current;
    const next = Math.min(300, Math.max(50, Math.round((base + delta) / 10) * 10));
    applyZoom(next);
    setZoom(next);
  }, [applyZoom]);

  const resetPdfZoom = useCallback(() => {
    applyZoom("fit");
    setZoom("fit");
  }, [applyZoom]);

  const nudgeEpubFontSize = useCallback((direction: 1 | -1) => {
    setHasFontSizeOverride(true);
    setReaderSettings((current) => ({
      ...current,
      fontSize: nudgeFontSize(current.fontSize, direction),
    }));
  }, []);

  const resetEpubFontSize = useCallback(() => {
    setHasFontSizeOverride(false);
    setReaderSettings((current) => ({
      ...current,
      fontSize: globalFontSizeRef.current,
    }));
  }, []);

  const handleReaderZoomShortcut = useCallback((
    event: KeyboardEvent,
    format: Book["format"],
  ): boolean => {
    const action = zoomShortcutActionForEvent(event);
    if (action === null) return false;
    event.preventDefault();
    event.stopPropagation();
    if (format === "pdf") {
      if (action === "reset") resetPdfZoom();
      else handleZoom(action * 10);
    } else if (action === "reset") {
      resetEpubFontSize();
    } else {
      nudgeEpubFontSize(action);
    }
    return true;
  }, [handleZoom, nudgeEpubFontSize, resetEpubFontSize, resetPdfZoom]);

  const handleReaderSettingsChange = useCallback((settings: ReaderSettingsState) => {
    if (settings.fontSize !== readerSettingsRef.current.fontSize) {
      setHasFontSizeOverride(true);
    }
    setReaderSettings(settings);
  }, []);

  // Track the current fit-width scale so +/- from fit mode lands near the
  // visible size. Observes the renderer and sums the natural widths of the
  // pages in a single row — one page in single mode, two in spread mode —
  // to match what fixed-layout.js / pdf-scroll.js actually fit.
  useEffect(() => {
    if (!bookReady || book?.format !== "pdf") return;
    const renderer = viewRef.current?.renderer;
    const foliateBook = viewRef.current?.book;
    if (!renderer || !foliateBook?.getPageSize) return;
    const isSpread = readerSettings.pageColumns === 2;
    let cancelled = false;
    const update = async () => {
      try {
        const first = await foliateBook.getPageSize(0);
        const second = isSpread ? await foliateBook.getPageSize(1).catch(() => null) : null;
        if (cancelled || !first?.width) return;
        const rowWidth = first.width + (second?.width ?? 0);
        const containerW = Math.max(renderer.clientWidth - 24, 1);
        const computed = Math.round((containerW / rowWidth) * 100);
        fitPctRef.current = computed;
        setFitPercent(computed);
      } catch { /* book may have closed */ }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(renderer);
    return () => { cancelled = true; ro.disconnect(); };
  }, [bookReady, book?.format, readerSettings.readingMode, readerSettings.pageColumns]);

  useEffect(() => {
    if (!bookReady || book?.format !== "pdf" || !viewerRef.current) return;
    let raf = 0;
    const relayoutPdf = () => {
      const renderer = viewRef.current?.renderer as (HTMLElement & { relayout?: () => void }) | undefined;
      if (!renderer) return;
      if (renderer.hasAttribute("resize-dragging")) return;
      if (typeof renderer.relayout === "function") {
        renderer.relayout();
        return;
      }
      const value = zoomRef.current;
      renderer.setAttribute("zoom", value === "fit" ? "fit-width" : String(value / 100));
    };
    const ro = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(relayoutPdf);
    });
    ro.observe(viewerRef.current);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [bookReady, book?.format]);

  const dualIslandsAllowed = canShowDualIslands(workspaceInnerWidth, panelWidth);
  const dualIslandsAllowedRef = useRef(dualIslandsAllowed);
  dualIslandsAllowedRef.current = dualIslandsAllowed;

  const openSidePanel = useCallback((panel: Exclude<SidePanel, null>) => {
    if (!dualIslandsAllowedRef.current) setTocOpen(false);
    setSidePanel(panel);
  }, []);

  const togglePanel = (panel: Exclude<SidePanel, null>) => {
    setSidePanel((prev) => {
      if (prev === panel) return null;
      if (!dualIslandsAllowed) setTocOpen(false);
      return panel;
    });
  };

  useEffect(() => {
    if (!dualIslandsAllowed && tocOpen && sidePanel) {
      setTocOpen(false);
    }
  }, [dualIslandsAllowed, tocOpen, sidePanel]);

  // Keyboard navigation — parent document listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isMainWindow && book?.format && handleReaderZoomShortcut(e, book.format)) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (!viewRef.current?.renderer) return;
      if (e.key === "ArrowLeft") viewRef.current.prev();
      else if (e.key === "ArrowRight") viewRef.current.next();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [book?.format, handleReaderZoomShortcut]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (text) {
      e.preventDefault();
      let sentence = text;
      let sentenceOffset = 0;
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        let node: Node | null = range.startContainer;
        const blockTags = new Set(["P", "DIV", "LI", "BLOCKQUOTE", "TD", "TH", "H1", "H2", "H3", "H4", "H5", "H6"]);
        while (node && !(node.nodeType === 1 && blockTags.has((node as Element).tagName))) {
          node = node.parentNode;
        }
        if (node && node.nodeType === 1) {
          const extracted = extractRangeSelectionContext(node as Element, range, text);
          sentence = extracted.sentence;
          sentenceOffset = extracted.matchStart;
        }
      }
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        text,
        sentence,
        sentenceOffset,
        cfiRange: undefined,
      });
    }
  }, []);

  const panelRef = useRef<HTMLDivElement>(null);
  const panelWidthRef = useRef(panelWidth);
  panelWidthRef.current = panelWidth;

  const handlePanelResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    isDragging.current = true;
    const handle = e.currentTarget;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startWidth = panelWidthRef.current;
    let rafId = 0;
    let latestWidth = startWidth;
    let finished = false;

    // Signal to foliate-js renderer to skip expensive re-renders during drag
    const renderer = (viewRef.current as unknown as HTMLElement)?.shadowRoot
      ?.querySelector("foliate-paginator, foliate-fxl, foliate-pdf-scroll");
    renderer?.setAttribute("resize-dragging", "");

    const widthFromClientX = (clientX: number) => {
      const delta = startX - clientX;
      return Math.min(
        PANEL_MAX_WIDTH,
        Math.max(PANEL_MIN_WIDTH, startWidth + delta)
      );
    };

    const schedulePanelWidth = (width: number) => {
      latestWidth = width;
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        if (panelRef.current) {
          panelRef.current.style.width = `${latestWidth}px`;
        }
        rafId = 0;
      });
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("blur", handleWindowBlur);
      handle.removeEventListener("lostpointercapture", handleLostPointerCapture);
      try {
        if (handle.hasPointerCapture(pointerId)) {
          handle.releasePointerCapture(pointerId);
        }
      } catch { /* pointer capture can already be gone */ }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // Remove drag signal — triggers one final render via attributeChangedCallback
      renderer?.removeAttribute("resize-dragging");
    };

    const finishDrag = (clientX?: number) => {
      if (finished) return;
      finished = true;
      isDragging.current = false;
      if (typeof clientX === "number") {
        latestWidth = widthFromClientX(clientX);
      }
      if (rafId) cancelAnimationFrame(rafId);
      if (panelRef.current) {
        panelRef.current.style.width = `${latestWidth}px`;
      }
      cleanup();
      setPanelWidth(latestWidth);
    };

    function handlePointerMove(e: PointerEvent) {
      if (!isDragging.current) return;
      schedulePanelWidth(widthFromClientX(e.clientX));
    }

    function handlePointerUp(e: PointerEvent) {
      finishDrag(e.clientX);
    }

    function handlePointerCancel() {
      finishDrag();
    }

    function handleWindowBlur() {
      finishDrag();
    }

    function handleLostPointerCapture() {
      finishDrag();
    }

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    try {
      handle.setPointerCapture(pointerId);
    } catch { /* pointer capture is best-effort */ }
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    window.addEventListener("blur", handleWindowBlur);
    handle.addEventListener("lostpointercapture", handleLostPointerCapture);
  }, []);

  const navigateToChapter = useCallback((href: string) => {
    pendingJumpFromPageRef.current = currentPageNumRef.current;
    viewRef.current?.goTo(href);
  }, []);

  const navigateToCfi = useCallback((cfi: string) => {
    pendingJumpFromPageRef.current = currentPageNumRef.current;
    viewRef.current?.goTo(cfi);
  }, []);

  const consumedNavStartupRef = useRef<string | null>(null);

  const applyNavigationOptions = useCallback(
    (opts: ReaderWindowOptions) => {
      const cfi = opts.cfi || undefined;
      if (opts.openVocab) {
        openSidePanel("vocab");
        if (cfi) {
          pendingJumpFromPageRef.current = currentPageNumRef.current;
          viewRef.current?.goTo(cfi).then(() => {
            viewRef.current?.addAnnotation({ value: cfi, color: "#c27aff" });
            setTimeout(() => {
              viewRef.current?.deleteAnnotation({ value: cfi });
            }, 3000);
          });
        }
        return;
      }

      if (opts.quote) {
        setAiContext({ text: opts.quote, cfi });
        openSidePanel("ai");
      } else if (opts.openChat) {
        openSidePanel("ai");
      }

      if (opts.chatId) {
        setInitialChatNav({ chatId: opts.chatId, seq: ++chatNavSeqRef.current });
      }

      if (cfi) {
        pendingJumpFromPageRef.current = currentPageNumRef.current;
        viewRef.current?.goTo(cfi);
      }
    },
    [openSidePanel],
  );

  // Handle deep-link navigation on reader open (Chats, Words, Highlights, Home, Cmd+K)
  // Supports both location.state (main window) and URL search params (standalone window)
  useEffect(() => {
    if (!bookReady) return;
    const nav = parseReaderNavigation(
      location.state as ReaderWindowOptions | null,
      window.location.search,
    );
    if (!nav) return;
    const o = nav.options;
    const requestKey = `${nav.source}:${bookId ?? ""}:${Boolean(o.openVocab)}:${Boolean(o.openChat)}:${o.chatId ?? ""}:${o.cfi ?? ""}:${o.quote ?? ""}`;
    if (consumedNavStartupRef.current === requestKey) return;
    consumedNavStartupRef.current = requestKey;
    applyNavigationOptions(o);
    if (!isStandaloneWindow && nav.source === "state") {
      navigate(location.pathname, { replace: true });
    }
  }, [bookId, bookReady, location.state, location.pathname, navigate, applyNavigationOptions]);

  // Handle deep-link navigation delivered to an already-open reader window after focusWindow
  useEffect(() => {
    if (!bookReady) return;
    let active = true;
    const unlistenPromise = listenCurrentWindow<ReaderWindowOptions>(
      READER_NAVIGATE_EVENT,
      (event) => {
        if (!active || !event.payload) return;
        applyNavigationOptions(event.payload);
      },
    );
    return () => {
      active = false;
      void unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, [bookReady, applyNavigationOptions]);

  const toggleTocPanel = () => {
    setTocOpen((open) => {
      const next = !open;
      if (next && !dualIslandsAllowed) setSidePanel(null);
      return next;
    });
    setSettingsOpen(false);
  };

  const handleTocNavigate = (page: number) => {
    const chapter = chapters[page - 1];
    if (chapter?.targetHref) navigateToChapter(chapter.targetHref);
  };

  const paperStyles = getThemeStyles(readerSettings.theme);
  const isDarkPaper = readerSettings.theme === "dark";
  const currentChapter =
    currentChapterIndex >= 0 && currentChapterIndex < chapters.length
      ? chapters[currentChapterIndex]
      : undefined;

  const pdfPageRangeLabel = useMemo(() => {
    if (!pageInfo) return null;
    if (readerSettings.pageColumns === 2) {
      if (pdfSpreadRange && pdfSpreadRange.end > pdfSpreadRange.start) {
        return t("reader.pageRangeOf", {
          start: pdfSpreadRange.start,
          end: pdfSpreadRange.end,
          total: pageInfo.total,
        });
      }
      if (readerSettings.readingMode === "scrolling") {
        const start = pageInfo.current % 2 === 1 ? pageInfo.current : Math.max(1, pageInfo.current - 1);
        const end = Math.min(pageInfo.total, start + 1);
        if (end > start) {
          return t("reader.pageRangeOf", { start, end, total: pageInfo.total });
        }
      }
    }
    return t("reader.pageOf", { current: pageInfo.current, total: pageInfo.total });
  }, [pageInfo, pdfSpreadRange, readerSettings.pageColumns, readerSettings.readingMode, t]);

  const timeLeftLabel = useMemo(() => {
    if (timeLeftMinutes === null || timeLeftMinutes <= 0) return null;
    if (timeLeftMinutes < 60) {
      return t("reader.timeLeftMinutes", { count: Math.max(1, Math.round(timeLeftMinutes)) });
    }
    return t("reader.timeLeftHours", { count: Math.max(1, Math.round(timeLeftMinutes / 60)) });
  }, [timeLeftMinutes, t]);

  const shellClass = readerShellClassForTheme(readerSettings.theme);

  if (loading || !book) {
    return (
      <div
        className={`flex flex-col h-screen ${shellClass} ${
          isWin ? "overflow-hidden" : `items-center justify-center ${loading ? "gap-3" : "gap-4"}`
        }`}
      >
        {isWin && (
          <header
            data-drag-region
            className="h-16 px-3 sm:px-6 py-3.5 shrink-0 flex items-center justify-end relative select-none"
          >
            <WindowControls showDivider={false} />
          </header>
        )}
        <div
          className={
            isWin
              ? `flex-1 flex flex-col items-center justify-center ${loading ? "gap-3" : "gap-4"}`
              : "contents"
          }
        >
          {loading ? (
            <>
              <Loader2 size={24} className="animate-spin text-text-tertiary" />
              <p className="text-text-secondary text-[14px]">{t("reader.loading")}</p>
            </>
          ) : (
            <>
              <p className="text-[15px] font-medium text-text-primary">{t("reader.bookNotFound")}</p>
              <Button appearance="dawn" variant="secondary" size="md" onClick={handleBackToLibrary}>
                <ArrowLeft size={16} />
                <span>{t("reader.backToLibrary")}</span>
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }

  const toolbarSubtitle =
    book.format === "pdf"
      ? ["PDF", currentChapter?.title, pdfPageRangeLabel].filter(Boolean).join(" · ")
      : currentChapter?.breadcrumb || book.author;

  const progressPillLabel =
    book.format === "pdf"
      ? (pdfPageRangeLabel ?? `${progress}%`)
      : chapters.length > 0 && currentChapterIndex >= 0
        ? t("reader.chapterOf", { current: currentChapterIndex + 1, total: chapters.length })
        : pageInfo
          ? t("reader.pageOf", { current: pageInfo.current, total: pageInfo.total })
          : `${progress}%`;

  const paperSurfaceStyle: React.CSSProperties = {
    backgroundColor:
      book.format === "pdf" && readerSettings.theme === "original"
        ? "#EFEBF7"
        : paperStyles.body,
    borderColor: paperStyles.border,
    color: paperStyles.text,
    ...getReaderScrollbarVars(book.format, readerSettings.theme),
  } as React.CSSProperties;

  return (
    <div className={`flex flex-col h-screen ${shellClass} overflow-hidden`}>
      {/* Invisible overlay to close popovers when clicking anywhere */}
      {settingsOpen && (
        <div
          className="fixed inset-0 z-40"
          onMouseDown={(e) => { e.preventDefault(); setSettingsOpen(false); }}
        />
      )}

      {/* 64px Dawn Reader Toolbar */}
      <header
        data-drag-region={isMac || isWin ? "" : undefined}
        className={
          isWin
            ? "h-16 px-3 sm:px-6 py-3.5 shrink-0 flex items-center justify-between gap-2 sm:gap-4 relative select-none"
            : "h-16 px-6 py-3.5 shrink-0 flex items-center justify-between gap-4 relative select-none"
        }
      >
        {/* Left cluster */}
        <div
          className={
            isWin ? "flex items-center gap-2 sm:gap-4 min-w-0" : "flex items-center gap-4 min-w-0"
          }
        >
          {isMac && <div className={`${MAC_TRAFFIC_LIGHT_SPACER_CLASS} h-3 shrink-0`} aria-hidden="true" />}

          <IconButton
            onClick={handleToolbarLibraryClick}
            aria-label={t("reader.backToLibrary")}
            title={t("reader.backToLibrary")}
            className={isWin ? "max-sm:size-8" : undefined}
          >
            <ChevronLeft size={16} />
          </IconButton>

          <IconButton
            active={tocOpen}
            aria-label={t(tocOpen ? "reader.tocClose" : "reader.tocOpen")}
            aria-expanded={tocOpen}
            title={t(tocOpen ? "reader.tocClose" : "reader.tocOpen")}
            onClick={toggleTocPanel}
            className={isWin ? "max-sm:size-8" : undefined}
          >
            <List size={16} />
          </IconButton>

          <div className="flex flex-col gap-px min-w-0">
            <h1 className="text-[14px] font-semibold text-text-primary leading-[18px] truncate">
              {book.title}
            </h1>
            {toolbarSubtitle && (
              <span className="text-[12px] text-text-tertiary leading-4 truncate">
                {toolbarSubtitle}
              </span>
            )}
          </div>
        </div>

        {/* Right cluster */}
        <div
          className={
            isWin
              ? "flex items-center gap-1.5 sm:gap-2 shrink-0"
              : "flex items-center gap-2 shrink-0"
          }
        >
          <IconButton
            ref={settingsAnchorRef}
            active={settingsOpen}
            aria-label={t("readerSettings.typography")}
            title={t("readerSettings.typography")}
            className={isWin ? "max-sm:size-8" : undefined}
            onClick={() => {
              setSettingsOpen((open) => !open);
              setTocOpen(false);
            }}
          >
            <Type size={16} />
          </IconButton>
          <ReaderSettings
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            anchorRef={settingsAnchorRef}
            settings={readerSettings}
            onSettingsChange={handleReaderSettingsChange}
            bookFormat={book.format}
          />

          <IconButton
            active={sidePanel === "bookmarks"}
            aria-label={t("reader.bookmarksAndHighlights")}
            title={t("reader.bookmarksAndHighlights")}
            className={isWin ? "max-sm:size-8" : undefined}
            onClick={() => togglePanel("bookmarks")}
          >
            <Bookmark size={16} />
          </IconButton>

          <IconButton
            active={sidePanel === "vocab"}
            aria-label={t("vocab.title")}
            title={t("vocab.title")}
            className={isWin ? "max-sm:size-8" : undefined}
            onClick={() => togglePanel("vocab")}
          >
            <Languages size={16} />
          </IconButton>

          <IconButton
            active={sidePanel === "ai"}
            aria-label={t("reader.aiAssistant")}
            title={t("reader.aiAssistant")}
            className={isWin ? "max-sm:size-8" : undefined}
            onClick={() => togglePanel("ai")}
          >
            <Sparkles size={16} />
          </IconButton>
          <WindowControls />
        </div>
      </header>

      {/* Body workspace */}
      <div ref={workspaceRef} className="flex-1 min-h-0 flex gap-4 px-5 pb-5 pt-0">
        <TableOfContents
          open={tocOpen}
          chapters={tocChapters}
          currentPage={currentChapterIndex + 1}
          onNavigate={handleTocNavigate}
          onClose={() => setTocOpen(false)}
        />

        {/* Floating Paper Island */}
        <main
          className="flex-1 min-w-0 h-full relative rounded-surface border shadow-glass overflow-hidden @container/paper"
          style={paperSurfaceStyle}
          onContextMenu={handleContextMenu}
          onClick={() => {
            setSettingsOpen(false);
            // Clicks inside the iframe (text content) don't bubble out
            // through the sandbox boundary, so this fires only for clicks
            // on the margins/white space around the page — i.e. "anywhere
            // else" from the reader's perspective. Drop the in-iframe text
            // selection so the highlight doesn't linger.
            if (viewRef.current?.renderer) {
              viewRef.current.deselect?.();
            }
            setHighlightToolbar(null);
          }}
        >
          {/* Reserve 72px (or 108px below 700px Paper width where jump-back stacks
              above the pill) so content never sits behind floating controls and
              viewport height stays constant when jump-back appears or disappears. */}
          <div
            className="w-full h-full flex flex-col pb-[108px] @[700px]/paper:pb-[72px]"
            style={{
              backgroundColor:
                book.format === "pdf"
                  ? readerSettings.theme === "original"
                    ? "#EFEBF7"
                    : "#ffffff"
                  : paperStyles.body,
              filter: `brightness(${readerSettings.brightness / 100})`,
            }}
          >
            <div
              ref={viewerRef}
              className="w-full flex-1 min-h-0"
              style={
                book.format === "pdf"
                  ? { backgroundColor: readerSettings.theme === "original" ? "#EFEBF7" : "#ffffff" }
                  : undefined
              }
            />
          </div>
          {book.format === "pdf" && (() => {
            const overlay = getPdfOverlays(readerSettings.theme);
            if (!overlay) return null;
            return overlay.layers.map((style, i) => (
              <div
                key={i}
                className="z-10 pointer-events-none absolute inset-0"
                style={style}
              />
            ));
          })()}

          {initError && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-paper/95">
              <div className="flex flex-col items-center gap-3 max-w-[420px] px-8 text-center">
                <AlertCircle size={24} className="text-danger" />
                <span className="text-[15px] font-medium text-text-primary">
                  {t("reader.openFailed")}
                </span>
                <Button appearance="dawn" variant="secondary" size="sm" onClick={handleBackToLibrary}>
                  <ArrowLeft size={14} />
                  <span>{t("reader.backToLibrary")}</span>
                </Button>
              </div>
            </div>
          )}

              {!bookReady && !initError && (
                <div
                  className="absolute inset-0 z-20 flex items-center justify-center"
                  style={{ backgroundColor: paperSurfaceStyle.backgroundColor }}
                >
                  <div className="flex flex-col items-center gap-3">
                    <Loader2 size={24} className="animate-spin text-text-tertiary" />
                    <span className="text-[14px] text-text-secondary">
                      {t("reader.preparingBook")}
                    </span>
                  </div>
                </div>
              )}

              {/* Bottom floating pills */}
              {bookReady && !initError && (
                <ReaderBottomPills
                  bookFormat={book.format}
                  isDarkPaper={isDarkPaper}
                  canGoBack={canGoBack}
                  jumpBackPage={jumpBackPage}
                  onGoBack={goBackInHistory}
                  progress={progress}
                  progressPillLabel={progressPillLabel}
                  timeLeftLabel={timeLeftLabel}
                  zoom={zoom}
                  fitPercent={fitPercent}
                  onZoom={handleZoom}
                  onResetPdfZoom={resetPdfZoom}
                  onPrev={() => viewRef.current?.prev()}
                  onNext={() => viewRef.current?.next()}
                />
              )}
            </main>

            {sidePanel && (
              <div
                onPointerDown={handlePanelResizePointerDown}
                className="w-4 -mx-4 h-full shrink-0 cursor-col-resize touch-none flex items-center justify-center group z-10"
              >
                <div className="w-1 h-12 rounded-full bg-transparent group-hover:bg-accent/40 transition-colors" />
              </div>
            )}

            <div
              ref={panelRef}
              className={sidePanel ? "shrink-0 min-w-0 h-full" : "hidden"}
              style={{
                width: panelWidth,
                maxWidth: tocOpen && dualIslandsAllowed ? "calc(100% - 572px)" : "calc(100% - 256px)",
              }}
            >
              <div
                className={
                  sidePanel === "ai"
                    ? "h-full rounded-surface overflow-hidden reader-island"
                    : "hidden"
                }
              >
                <AiPanel
                  bookId={bookId}
                  bookTitle={book.title}
                  bookAuthor={book.author}
                  currentChapter={currentChapter?.title}
                  context={aiContext}
                  initialChatId={initialChatNav.chatId}
                  initialChatSeq={initialChatNav.seq}
                  visible={sidePanel === "ai"}
                  onContextConsumed={() => setAiContext(undefined)}
                  onNavigateToCfi={(cfi) => {
                    pendingJumpFromPageRef.current = currentPageNumRef.current;
                    viewRef.current?.goTo(cfi).then(() => {
                      viewRef.current?.addAnnotation({ value: cfi, color: "#c27aff" });
                      setTimeout(() => {
                        viewRef.current?.deleteAnnotation({ value: cfi });
                      }, 3000);
                    });
                  }}
                  onClose={() => setSidePanel(null)}
                />
              </div>
              {sidePanel === "bookmarks" && bookId && (
                <BookmarksPanel
                  bookId={bookId}
                  bookTitle={book.title}
                  currentCfi={currentCfi}
                  highlightVersion={highlightVersion}
                  onNavigate={navigateToCfi}
                  onAsk={(text, cfi, page) => {
                    const resolvedPage =
                      page ??
                      (book.format === "pdf" && cfi
                        ? resolvePdfPageFromCfi(cfi, viewRef.current?.book?.sections?.length ?? 0)
                        : null);
                    setAiContext({ text, cfi, page: resolvedPage });
                    openSidePanel("ai");
                  }}
                  onRemoveHighlight={(cfiRange) => {
                    viewRef.current?.deleteAnnotation({ value: cfiRange });
                  }}
                  getCurrentCfi={() => currentCfiRef.current}
                  getCurrentLabel={() => currentChapter?.title || t("common.bookmark")}
                  resolvePages={resolveSavedItemPages}
                />
              )}
              {sidePanel === "vocab" && bookId && (
                <div className="h-full rounded-surface overflow-hidden reader-island">
                  <DictionaryPanel
                    bookId={bookId}
                    bookTitle={book.title}
                    vocabVersion={vocabVersion}
                    onNavigate={(cfi) => {
                      pendingJumpFromPageRef.current = currentPageNumRef.current;
                      viewRef.current?.goTo(cfi).then(() => {
                        viewRef.current?.addAnnotation({ value: cfi, color: "#c27aff" });
                        setTimeout(() => {
                          viewRef.current?.deleteAnnotation({ value: cfi });
                        }, 3000);
                      });
                    }}
                    resolvePages={resolveSavedItemPages}
                    onClose={() => setSidePanel(null)}
                    onOpenInWords={handleOpenInWords}
                  />
                </div>
              )}
            </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <ReaderContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          text={contextMenu.text}
          onClose={() => setContextMenu(null)}
          onCopy={() => {
            navigator.clipboard.writeText(contextMenu.text);
            setContextMenu(null);
          }}
          onInspect={(classification) => {
            const chapterTitle = currentChapterIndex >= 0 && currentChapterIndex < chapters.length
              ? chapters[currentChapterIndex].title
              : undefined;
            setSelectionPopover({
              x: contextMenu.x,
              y: contextMenu.y,
              text: contextMenu.text,
              sentence: contextMenu.sentence,
              bookTitle: book?.title,
              chapter: chapterTitle,
              cfi: contextMenu.cfiRange,
              sectionIndex: contextMenu.sectionIndex,
              classification,
            });
            setContextMenu(null);
          }}
          onQuote={() => {
            setAiContext({
              text: contextMenu.text,
              cfi: contextMenu.cfiRange,
              page: resolveQuotedPage({
                format: book.format,
                cfi: contextMenu.cfiRange,
                sectionIndex: contextMenu.sectionIndex,
                sectionCount: viewRef.current?.book?.sections?.length ?? 0,
                fallbackPage: pageInfo?.current ?? null,
              }),
            });
            openSidePanel("ai");
            setContextMenu(null);
          }}
          onTranslate={() => {
            setTranslation({
              x: contextMenu.x,
              y: contextMenu.y,
              text: contextMenu.text,
              context: contextMenu.sentence,
              contextOffset: contextMenu.sentenceOffset,
              cfi: contextMenu.cfiRange,
            });
            setContextMenu(null);
          }}
          onHighlight={(color) => {
            const cfiRange = contextMenu.cfiRange;
            if (cfiRange && bookId) {
              invoke<Highlight>("add_highlight", {
                bookId,
                cfiRange,
                color,
                textContent: contextMenu.text,
              }).then((hl) => {
                viewRef.current?.addAnnotation({ value: hl.cfi_range, color: hl.color });
                setHighlightVersion((v) => v + 1);
              }).catch((err) => console.error("Failed to add highlight:", err));
            }
            setContextMenu(null);
          }}
        />
      )}

      {selectionPopover && (
        <ExplainSelectionPopover
          x={selectionPopover.x}
          y={selectionPopover.y}
          text={selectionPopover.text}
          sentence={selectionPopover.sentence}
          bookTitle={selectionPopover.bookTitle}
          chapter={selectionPopover.chapter}
          bookId={bookId!}
          cfi={selectionPopover.cfi}
          initialMode={selectionPopover.classification.mode}
          grayZone={selectionPopover.classification.grayZone}
          normalizedTerm={selectionPopover.classification.normalizedTerm}
          onSaved={() => setVocabVersion((v) => v + 1)}
          onQuote={() => {
            setAiContext({
              text: selectionPopover.text,
              cfi: selectionPopover.cfi,
              page: resolveQuotedPage({
                format: book.format,
                cfi: selectionPopover.cfi,
                sectionIndex: selectionPopover.sectionIndex,
                sectionCount: viewRef.current?.book?.sections?.length ?? 0,
                fallbackPage: pageInfo?.current ?? null,
              }),
            });
            openSidePanel("ai");
            setSelectionPopover(null);
          }}
          onClose={() => setSelectionPopover(null)}
        />
      )}

      {translation && (
        <TranslationPopover
          x={translation.x}
          y={translation.y}
          text={translation.text}
          context={translation.context}
          contextOffset={translation.contextOffset}
          bookId={bookId!}
          cfi={translation.cfi}
          onClose={() => setTranslation(null)}
        />
      )}

      {highlightToolbar && (
        <HighlightToolbar
          x={highlightToolbar.x}
          y={highlightToolbar.y}
          currentColor={highlightToolbar.color}
          onChangeColor={(color) => {
            invoke("update_highlight_color", { id: highlightToolbar.highlightId, color })
              .then(() => {
                // Remove old annotation and add with new color
                viewRef.current?.deleteAnnotation({ value: highlightToolbar.cfiRange });
                viewRef.current?.addAnnotation({ value: highlightToolbar.cfiRange, color });
                setHighlightToolbar((prev) => prev ? { ...prev, color } : null);
                setHighlightVersion((v) => v + 1);
              })
              .catch((err) => console.error("Failed to update highlight color:", err));
          }}
          onAsk={
            highlightToolbar.text
              ? () => {
                  setAiContext({
                    text: highlightToolbar.text!,
                    cfi: highlightToolbar.cfiRange,
                    page: resolveQuotedPage({
                      format: book.format,
                      cfi: highlightToolbar.cfiRange,
                      sectionIndex: highlightToolbar.sectionIndex,
                      sectionCount: viewRef.current?.book?.sections?.length ?? 0,
                      fallbackPage: pageInfo?.current ?? null,
                    }),
                  });
                  openSidePanel("ai");
                  setHighlightToolbar(null);
                }
              : undefined
          }
          onDelete={() => {
            invoke("remove_highlight", { id: highlightToolbar.highlightId })
              .then(() => {
                viewRef.current?.deleteAnnotation({ value: highlightToolbar.cfiRange });
                setHighlightToolbar(null);
                setHighlightVersion((v) => v + 1);
              })
              .catch((err) => console.error("Failed to remove highlight:", err));
          }}
          onClose={() => setHighlightToolbar(null)}
        />
      )}
    </div>
  );
}
