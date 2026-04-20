import { useState, useRef, useCallback, useEffect } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  ArrowLeft,
  BookOpen,
  List,
  Bookmark,
  Bot,
  Languages,
  Loader2,
  Minus,
  Plus,
} from "lucide-react";
import Button from "../components/ui/Button";
import AiPanel from "../components/AiPanel";
import BookmarksPanel from "../components/BookmarksPanel";
import ReaderSettings, { type ReaderSettingsState, getFontFamily, getThemeStyles, getDefaultReaderTheme } from "../components/ReaderSettings";
import ReaderContextMenu from "../components/ReaderContextMenu";
import HighlightToolbar from "../components/HighlightToolbar";
import LookupPopover from "../components/LookupPopover";
import DictionaryPanel from "../components/DictionaryPanel";
import TranslationPopover from "../components/TranslationPopover";
import TableOfContents from "../components/TableOfContents";
import { getBook, updateReadingProgress, checkBookAvailable, type Book } from "../hooks/useBooks";
import { getAllSettings } from "../hooks/useSettings";
import type { Highlight } from "../hooks/useBookmarks";

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
  addAnnotation(annotation: { value: string; color?: string }): Promise<any>;
  deleteAnnotation(annotation: { value: string }): Promise<void>;
  deselect(): void;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

type PdfOverlay = { layers: React.CSSProperties[] } | null;

function getPdfOverlays(theme: string): PdfOverlay {
  switch (theme) {
    case "paper": return { layers: [{
      backgroundColor: getThemeStyles("paper").body,
      mixBlendMode: "multiply",
    }] };
    case "quiet": return { layers: [
      { backgroundColor: "#ffffff", mixBlendMode: "difference" },
      { backgroundColor: getThemeStyles("quiet").body, mixBlendMode: "screen" },
    ] };
    case "dark": return { layers: [
      { backgroundColor: "#ffffff", mixBlendMode: "difference" },
      { backgroundColor: getThemeStyles("dark").body, mixBlendMode: "screen" },
    ] };
    default: return null;
  }
}

function getReaderThemeVars(theme: string): Record<string, string> | undefined {
  switch (theme) {
    case "original": return {
      // Mirrors the :root light palette in src/index.css so the reader view
      // stays cohesive when the reader theme is Original but the system /
      // app theme is dark.
      "--color-bg-page": "#f4f4f5",
      "--color-bg-surface": "#ffffff",
      "--color-bg-muted": "#fafafa",
      "--color-bg-input": "#f3f3f5",
      "--color-text-primary": "#18181b",
      "--color-text-body": "#0a0a0a",
      "--color-text-secondary": "#52525c",
      "--color-text-muted": "#71717b",
      "--color-text-placeholder": "#a1a1aa",
      "--color-border": "#e4e4e7",
      "--color-border-light": "#f4f4f5",
      "--color-accent-bg": "#f3e8ff",
    };
    case "paper": return {
      "--color-bg-page": "#E8D5B8",
      "--color-bg-surface": "#F2E2C9",
      "--color-bg-muted": "#ECD9BC",
      "--color-bg-input": "#E2CEAF",
      "--color-text-primary": "#34271B",
      "--color-text-body": "#34271B",
      "--color-text-secondary": "#5C4A38",
      "--color-text-muted": "#8B7355",
      "--color-text-placeholder": "#8B7355",
      "--color-border": "#D4BA97",
      "--color-border-light": "#E2CEAF",
      "--color-accent-bg": "#E8D0B0",
    };
    case "quiet": return {
      "--color-bg-page": "#5A5A63",
      "--color-bg-surface": "#71717b",
      "--color-bg-muted": "#68686F",
      "--color-bg-input": "#5A5A63",
      "--color-text-primary": "#fafafa",
      "--color-text-body": "#fafafa",
      "--color-text-secondary": "#d4d4d8",
      "--color-text-muted": "#d4d4d8",
      "--color-text-placeholder": "#a1a1aa",
      "--color-border": "#9999a1",
      "--color-border-light": "#5A5A63",
      "--color-accent-bg": "#5A4D6E",
    };
    case "dark": return {
      "--color-bg-page": "#09090b",
      "--color-bg-surface": "#18181b",
      "--color-bg-muted": "#1c1c1f",
      "--color-bg-input": "#27272a",
      "--color-text-primary": "#d4d4d8",
      "--color-text-body": "#d4d4d8",
      "--color-text-secondary": "#a1a1aa",
      "--color-text-muted": "#71717a",
      "--color-text-placeholder": "#52525c",
      "--color-border": "#3f3f46",
      "--color-border-light": "#27272a",
      "--color-accent-bg": "#2d1b4e",
    };
    default: return undefined;
  }
}

const getReaderCSS = (settings: ReaderSettingsState) => {
  const themeColors = getThemeStyles(settings.theme);
  const fontFamily = getFontFamily(settings.font);
  const letterSpacing = settings.charSpacing === 0 ? "normal" : `${settings.charSpacing * 0.01}em`;
  const wordSpacing = settings.wordSpacing === 0 ? "normal" : `${settings.wordSpacing * 0.01}em`;
  return `
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
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: ${themeColors.text}33; border-radius: 9999px; }
    ::-webkit-scrollbar-thumb:hover { background: ${themeColors.text}55; }
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
const PANEL_DEFAULT_WIDTH = 525;

type SidePanel = "ai" | "bookmarks" | "vocab" | null;

interface TocChapter {
  title: string;
  href: string;
  depth: number;
}

const highlightColorMap: Record<string, string> = {
  yellow: "#FBBF24",
  green: "#34D399",
  blue: "#60A5FA",
  pink: "#F472B6",
  purple: "#A78BFA",
};

const appWindow = getCurrentWebviewWindow();
const isStandaloneWindow = appWindow.label.startsWith("reader-");

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
  const currentCfiRef = useRef<string | null>(null);
  const [bookReady, setBookReady] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const backButtonTimerRef = useRef<number | null>(null);
  const [icloudDownloading, setIcloudDownloading] = useState(false);
  const [icloudTimeout, setIcloudTimeout] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    text: string;
    sentence: string;
    cfiRange?: string;
  } | null>(null);
  const [aiContext, setAiContext] = useState<{ text: string; cfi?: string } | undefined>();
  const [initialChatId, setInitialChatId] = useState<string | undefined>();
  const [lookup, setLookup] = useState<{
    x: number;
    y: number;
    word: string;
    sentence: string;
    bookTitle?: string;
    chapter?: string;
    cfi?: string;
  } | null>(null);
  const [translation, setTranslation] = useState<{
    x: number;
    y: number;
    text: string;
    context?: string;
    cfi?: string;
  } | null>(null);
  const [highlightToolbar, setHighlightToolbar] = useState<{
    x: number;
    y: number;
    highlightId: string;
    cfiRange: string;
    color: string;
  } | null>(null);
  const [readerSettings, setReaderSettings] = useState<ReaderSettingsState>(() => ({
    theme: getDefaultReaderTheme(),
    font: "georgia",
    fontSize: 26,
    brightness: 100,
    readingMode: "scrolling",
    pageColumns: 2,
    lineSpacing: 1.8,
    charSpacing: 0,
    wordSpacing: 0,
    margins: 0,
  }));

  const settingsAnchorRef = useRef<HTMLButtonElement>(null);
  const tocAnchorRef = useRef<HTMLButtonElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateView | null>(null);
  const isDragging = useRef(false);
  const chaptersRef = useRef<TocChapter[]>([]);
  const selectedTextRef = useRef<{ text: string; cfi: string } | null>(null);

  // Load book metadata and default settings from DB
  useEffect(() => {
    if (!bookId) return;
    getBook(bookId)
      .then((b) => {
        setBook(b);
        if (isStandaloneWindow && b) {
          appWindow.setTitle(b.title);
        }
      })
      .catch(() => setBook(null))
      .finally(() => setLoading(false));

    getAllSettings().then((globalSettings) => {
      const saved = localStorage.getItem(`reader-settings-${bookId}`);
      const bookSettings = saved ? JSON.parse(saved) as Partial<ReaderSettingsState> : {};
      const g = globalSettings;
      setReaderSettings((prev) => ({
        ...prev,
        theme: bookSettings.theme || (g.reader_theme as ReaderSettingsState["theme"]) || prev.theme,
        brightness: bookSettings.brightness ?? (g.brightness ? parseInt(g.brightness) : prev.brightness),
        pageColumns: bookSettings.pageColumns ?? (g.page_columns ? parseInt(g.page_columns) as ReaderSettingsState["pageColumns"] : prev.pageColumns),
        font: bookSettings.font || (g.font_family as ReaderSettingsState["font"]) || prev.font,
        fontSize: bookSettings.fontSize ?? (g.font_size ? parseInt(g.font_size) : prev.fontSize),
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
  }, [bookId]);

  // Persist reader settings to localStorage when they change — only after load completes
  // to avoid overwriting saved values with defaults during initialization
  const dbSettingsLoaded = useRef(false);
  useEffect(() => {
    if (!dbSettingsLoaded.current) return;
    localStorage.setItem(`reader-settings-${bookId}`, JSON.stringify(readerSettings));
  }, [readerSettings]);

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
    const unlistenPromise = appWindow.onResized(({ payload }) => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        try {
          const scale = await appWindow.scaleFactor();
          const logical = payload.toLogical(scale);
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

  // Wait for iCloud download if book is not locally available
  useEffect(() => {
    if (!book || book.available !== false) return;

    setIcloudDownloading(true);
    setIcloudTimeout(false);
    let cancelled = false;
    const startTime = Date.now();

    const poll = async () => {
      while (!cancelled) {
        if (Date.now() - startTime > 60_000) {
          setIcloudTimeout(true);
          return;
        }
        const available = await checkBookAvailable(book.id).catch(() => false);
        if (available) {
          // Re-fetch book to get updated available flag
          const updated = await getBook(book.id).catch(() => null);
          if (updated) setBook(updated);
          setIcloudDownloading(false);
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    };

    poll();
    return () => { cancelled = true; };
  }, [book?.id, book?.available]);

  // Initialize foliate-js when book data is loaded
  useEffect(() => {
    if (!book || !viewerRef.current || book.available === false) return;

    const container = viewerRef.current;
    container.innerHTML = "";
    setBookReady(false);

    let cancelled = false;

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

      const view = document.createElement("foliate-view") as FoliateView;
      view.style.width = "100%";
      view.style.height = "100%";
      // Opt into the continuous-scroll PDF renderer before open(); view.js
      // branches its internal renderer pick on this attribute. EPUBs ignore it.
      if (book.format === "pdf" && readerSettings.readingMode === "scrolling") {
        view.setAttribute("pdf-mode", "scroll");
      }
      container.appendChild(view);
      viewRef.current = view;

      // Fetch EPUB as blob for foliate-js
      const fileUrl = convertFileSrc(book.file_path);
      const response = await fetch(fileUrl);
      const ext = book.format === "pdf" ? "pdf" : "epub";
      const blob = new File([await response.blob()], `book.${ext}`);
      await view.open(blob);

      if (cancelled) return;

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
        const flattenToc = (items: any[], depth = 0): TocChapter[] =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          items.flatMap((item: any) => [
            { title: item.label?.trim() || "", href: item.href, depth },
            ...(item.subitems ? flattenToc(item.subitems, depth + 1) : []),
          ]);
        const chs = flattenToc(toc);
        chaptersRef.current = chs;
        setChapters(chs);
      }

      // Listen for location changes
      view.addEventListener("relocate", ((e: CustomEvent) => {
        const { fraction, location, tocItem, cfi } = e.detail;

        const pct = Math.round((fraction ?? 0) * 100);
        setProgress(pct);
        currentCfiRef.current = cfi;

        if (location) {
          setPageInfo({ current: location.current + 1, total: location.total });
        }

        if (tocItem) {
          const idx = chaptersRef.current.findIndex((c) => c.href === tocItem.href);
          if (idx !== -1) setCurrentChapterIndex(idx);
        }

        if (bookId) {
          updateReadingProgress(bookId, pct, cfi).catch(() => {});
        }
      }) as EventListener);

      // Track navigation history for back button. Auto-hide 10s after the
      // last jump so it doesn't linger once the reader has settled.
      view.history.addEventListener("index-change", () => {
        const canBack = view.history.canGoBack;
        setCanGoBack(canBack);
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

      // Handle section loads — text selection, keyboard, highlights
      view.addEventListener("load", ((e: CustomEvent) => {
        const { doc, index } = e.detail;

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
            // Extract surrounding context from the containing block element
            let sentence = text;
            if (sel.rangeCount > 0) {
              const range = sel.getRangeAt(0);
              let node: Node | null = range.startContainer;
              // Walk up to the nearest block-level element
              const blockTags = new Set(["P", "DIV", "LI", "BLOCKQUOTE", "TD", "TH", "H1", "H2", "H3", "H4", "H5", "H6", "SECTION", "ARTICLE", "ASIDE", "FIGCAPTION", "DT", "DD"]);
              while (node && node !== doc.body && !(node.nodeType === 1 && blockTags.has((node as Element).tagName))) {
                node = node.parentNode;
              }
              // Fall back to body if no block element found
              const contextNode = node && node !== doc.body ? node : range.startContainer.parentElement;
              if (contextNode) {
                const blockText = (contextNode as Element).textContent?.trim() || "";
                sentence = blockText.length > 500 ? blockText.slice(0, 500) : blockText;
              }
            }
            setContextMenu({
              x: ev.clientX + offsetX,
              y: ev.clientY + offsetY,
              text,
              sentence,
              cfiRange: selectedTextRef.current?.cfi,
            });
          }
        });

        // Keyboard navigation inside content docs
        doc.addEventListener("keydown", (ev: KeyboardEvent) => {
          if ((ev.metaKey || ev.ctrlKey) && ev.key === "[") {
            ev.preventDefault();
            view.history.back();
          } else if ((ev.metaKey || ev.ctrlKey) && ev.key === "]") {
            ev.preventDefault();
            view.history.forward();
          } else if (ev.key === "ArrowLeft") view.prev();
          else if (ev.key === "ArrowRight") view.next();
          else if ((ev.metaKey || ev.ctrlKey) && (ev.key === "=" || ev.key === "+")) {
            ev.preventDefault();
            if (book?.format === "pdf") handleZoom(10);
          } else if ((ev.metaKey || ev.ctrlKey) && ev.key === "-") {
            ev.preventDefault();
            if (book?.format === "pdf") handleZoom(-10);
          }
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
        const color = highlightColorMap[annotation.color] || highlightColorMap.yellow;
        const isPdf = book?.format === "pdf";
        draw((rects: DOMRectList) => {
          const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
          g.setAttribute("fill", color);
          g.setAttribute("opacity", "0.35");
          g.style.mixBlendMode = "multiply";
          for (const { left, top, height, width } of rects) {
            const el = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            // PDF text layer spans have sub-pixel gaps; pad rects to close them
            const pad = isPdf ? 1 : 0;
            el.setAttribute("x", String(Math.floor(left)));
            el.setAttribute("y", String(top - pad));
            el.setAttribute("height", String(height + pad * 2));
            el.setAttribute("width", String(Math.ceil(width)));
            el.setAttribute("rx", isPdf ? "1" : "0");
            g.append(el);
          }
          return g;
        });
      }) as EventListener);

      view.addEventListener("show-annotation", ((e: CustomEvent) => {
        const { value, range } = e.detail;
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

      if (cancelled) return;

      // Apply brightness
      if (viewerRef.current) {
        viewerRef.current.style.filter = `brightness(${readerSettings.brightness / 100})`;
      }

      setBookReady(true);
    };

    initFoliate().catch((err) => {
      console.error("Failed to initialize foliate-js:", err);
      setBookReady(true); // Remove loading overlay even on error
    });

    return () => {
      cancelled = true;
      if (backButtonTimerRef.current !== null) {
        window.clearTimeout(backButtonTimerRef.current);
        backButtonTimerRef.current = null;
      }
      setCanGoBack(false);
      if (viewRef.current) {
        viewRef.current.close();
        viewRef.current.remove();
        viewRef.current = null;
      }
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

    // Update brightness
    if (viewerRef.current) {
      viewerRef.current.style.filter = `brightness(${readerSettings.brightness / 100})`;
    }
    // PDF theming is handled by the overlay div in the JSX
    // bookReady is in deps so this re-runs once foliate finishes init —
    // fixes a race where DB-loaded settings arrive before view.renderer exists.
  }, [readerSettings, book?.format, bookReady]);

  const zoomRef = useRef<number | "fit">(zoom);
  zoomRef.current = zoom;

  // Effective fit-width percentage, updated as the viewer resizes. Used to
  // seed the numeric zoom when the user clicks +/- from fit mode so the
  // transition is smooth (e.g. fit≈1.47 → tap + → 150%, not 110%).
  const fitPctRef = useRef(100);

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
        fitPctRef.current = Math.round((containerW / rowWidth) * 100);
      } catch { /* book may have closed */ }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(renderer);
    return () => { cancelled = true; ro.disconnect(); };
  }, [bookReady, book?.format, readerSettings.readingMode, readerSettings.pageColumns]);

  const togglePanel = (panel: "ai" | "bookmarks" | "vocab") => {
    setSidePanel((prev) => (prev === panel ? null : panel));
  };

  // Keyboard navigation — parent document listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowLeft") viewRef.current?.prev();
      else if (e.key === "ArrowRight") viewRef.current?.next();
      // Cmd+/Cmd- zoom for PDFs
      else if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        if (book?.format === "pdf") handleZoom(10);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "-") {
        e.preventDefault();
        if (book?.format === "pdf") handleZoom(-10);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [book?.format, handleZoom]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (text) {
      e.preventDefault();
      let sentence = text;
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        let node: Node | null = range.startContainer;
        const blockTags = new Set(["P", "DIV", "LI", "BLOCKQUOTE", "TD", "TH", "H1", "H2", "H3", "H4", "H5", "H6"]);
        while (node && !(node.nodeType === 1 && blockTags.has((node as Element).tagName))) {
          node = node.parentNode;
        }
        if (node) {
          const blockText = (node as Element).textContent?.trim() || "";
          sentence = blockText.length > 500 ? blockText.slice(0, 500) : blockText;
        }
      }
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        text,
        sentence,
        cfiRange: selectedTextRef.current?.cfi || undefined,
      });
    }
  }, []);

  const panelRef = useRef<HTMLDivElement>(null);
  const panelWidthRef = useRef(panelWidth);
  panelWidthRef.current = panelWidth;

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    const startX = e.clientX;
    const startWidth = panelWidthRef.current;
    let rafId = 0;
    let latestWidth = startWidth;

    // Signal to foliate-js renderer to skip expensive re-renders during drag
    const renderer = (viewRef.current as unknown as HTMLElement)?.shadowRoot
      ?.querySelector("foliate-paginator, foliate-fxl");
    renderer?.setAttribute("resize-dragging", "");

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = startX - e.clientX;
      latestWidth = Math.min(
        PANEL_MAX_WIDTH,
        Math.max(PANEL_MIN_WIDTH, startWidth + delta)
      );
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          if (panelRef.current) {
            panelRef.current.style.width = `${latestWidth}px`;
          }
          rafId = 0;
        });
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      isDragging.current = false;
      if (rafId) cancelAnimationFrame(rafId);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const delta = startX - e.clientX;
      const finalWidth = Math.min(
        PANEL_MAX_WIDTH,
        Math.max(PANEL_MIN_WIDTH, startWidth + delta)
      );
      // Remove drag signal — triggers one final render via attributeChangedCallback
      renderer?.removeAttribute("resize-dragging");
      setPanelWidth(finalWidth);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, []);

  const navigateToChapter = useCallback((href: string) => {
    viewRef.current?.goTo(href);
  }, []);

  const navigateToCfi = useCallback((cfi: string) => {
    viewRef.current?.goTo(cfi);
  }, []);

  // Handle navigation state from ChatsPage ("Open in Reader")
  // Supports both location.state (main window) and URL search params (standalone window)
  useEffect(() => {
    const state = location.state as { openChat?: boolean; chatId?: string } | null;
    const searchParams = new URLSearchParams(window.location.search);
    const openChat = state?.openChat || searchParams.get("openChat") === "true";
    const chatId = state?.chatId || searchParams.get("chatId") || undefined;
    if (!openChat || !bookReady) return;
    setSidePanel("ai");
    if (chatId) setInitialChatId(chatId);
    if (!isStandaloneWindow) navigate(location.pathname, { replace: true });
  }, [bookReady, location.state, location.pathname, navigate]);

  // Handle navigation state from DictionaryPage ("Open in Reader")
  // Supports both location.state (main window) and URL search params (standalone window)
  useEffect(() => {
    const state = location.state as { openVocab?: boolean; cfi?: string } | null;
    const searchParams = new URLSearchParams(window.location.search);
    const openVocab = state?.openVocab || searchParams.get("openVocab") === "true";
    const cfi = state?.cfi || searchParams.get("cfi") || undefined;
    if (!openVocab || !bookReady) return;
    setSidePanel("vocab");
    if (cfi) {
      viewRef.current?.goTo(cfi).then(() => {
        viewRef.current?.addAnnotation({ value: cfi, color: "#c27aff" });
        setTimeout(() => {
          viewRef.current?.deleteAnnotation({ value: cfi });
        }, 3000);
      });
    }
    // Clear the state so it doesn't re-trigger
    if (!isStandaloneWindow) navigate(location.pathname, { replace: true });
  }, [bookReady, location.state, location.pathname, navigate]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-text-muted">{t("reader.loading")}</p>
      </div>
    );
  }

  if (!book) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p>{t("reader.bookNotFound")}</p>
      </div>
    );
  }

  if (icloudDownloading) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-3">
        {icloudTimeout ? (
          <p className="text-text-muted text-[14px]">{t("reader.downloadTimeout")}</p>
        ) : (
          <>
            <Loader2 size={24} className="text-accent animate-spin" />
            <p className="text-text-muted text-[14px]">{t("reader.downloadingFromICloud")}</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-bg-page" style={getReaderThemeVars(readerSettings.theme) as React.CSSProperties}>
      {/* Invisible overlay to close popovers when clicking anywhere */}
      {(tocOpen || settingsOpen) && (
        <div
          className="fixed inset-0 z-40"
          onMouseDown={(e) => { e.preventDefault(); setTocOpen(false); setSettingsOpen(false); }}
        />
      )}
      {/* Header */}
      <header
        className={`flex items-center justify-between px-section pt-8 pb-2 shrink-0 relative select-none ${isStandaloneWindow ? "" : "bg-bg-surface border-b border-border"}`}
        style={isStandaloneWindow ? {
          backgroundColor: getThemeStyles(readerSettings.theme).body,
          color: getThemeStyles(readerSettings.theme).text,
          borderBottom: `1px solid ${getThemeStyles(readerSettings.theme).text}1a`,
        } : undefined}
      >
        <div data-tauri-drag-region className="absolute top-0 left-0 right-0 h-8" />

        {/* Left section */}
        <div className="flex items-center gap-3">
          {isStandaloneWindow ? (
            <div className="size-10 rounded-lg bg-accent flex items-center justify-center">
              <BookOpen size={18} className="text-white" />
            </div>
          ) : (
            <>
              <Button variant="icon" size="md" onClick={() => navigate("/")}>
                <ArrowLeft size={16} />
              </Button>
              <div className="w-px h-6 bg-border" />
            </>
          )}

          {isStandaloneWindow ? (
            <>
              {/* TOC on left in standalone window */}
              <div className="w-px h-6 bg-current opacity-15" />
              <Button
                ref={tocAnchorRef}
                variant="icon"
                size="md"
                active={tocOpen}
                onClick={() => { setTocOpen((v) => !v); setSettingsOpen(false); }}
              >
                <List size={16} />
              </Button>
              <TableOfContents
                open={tocOpen}
                onClose={() => setTocOpen(false)}
                chapters={chapters.map((c, i) => ({ title: c.title, page: i + 1, depth: c.depth }))}
                currentPage={currentChapterIndex + 1}
                onNavigate={(page) => {
                  const ch = chapters[page - 1];
                  if (ch) navigateToChapter(ch.href);
                }}
                anchorRef={tocAnchorRef}
                alignLeft
              />
            </>
          ) : (
            <>
              {/* Book icon + title on left in main window */}
              <div className="size-10 rounded-lg bg-accent flex items-center justify-center">
                <BookOpen size={18} className="text-white" />
              </div>
              <div className="flex flex-col">
                <h1 className="text-[16px] font-semibold text-text-primary leading-5">
                  {book.title}
                </h1>
                <span className="text-[13px] text-text-muted leading-4">
                  {book.format === "pdf"
                    ? pageInfo ? t("reader.pageOf", { current: pageInfo.current, total: pageInfo.total }) : ""
                    : chapters.length > 0 ? t("reader.chapterOf", { current: currentChapterIndex + 1, total: chapters.length }) : ""}
                </span>
              </div>
            </>
          )}
        </div>

        {/* Center — book title in standalone window */}
        {isStandaloneWindow && (
          <div className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center pointer-events-none">
            <h1 className="text-[14px] font-semibold leading-5" style={{ color: "inherit" }}>
              {book.title}
            </h1>
            <span className="text-[12px] leading-4 opacity-60">
              {book.format === "pdf"
                ? pageInfo ? t("reader.pageOf", { current: pageInfo.current, total: pageInfo.total }) : ""
                : chapters.length > 0 ? t("reader.chapterOf", { current: currentChapterIndex + 1, total: chapters.length }) : ""}
            </span>
          </div>
        )}

        {/* Right section */}
        <div className="flex items-center">
          {/* TOC button in main window */}
          {!isStandaloneWindow && (
            <>
              <Button
                ref={tocAnchorRef}
                variant="icon"
                size="md"
                active={tocOpen}
                onClick={() => { setTocOpen((v) => !v); setSettingsOpen(false); }}
              >
                <List size={16} />
              </Button>
              <TableOfContents
                open={tocOpen}
                onClose={() => setTocOpen(false)}
                chapters={chapters.map((c, i) => ({ title: c.title, page: i + 1, depth: c.depth }))}
                currentPage={currentChapterIndex + 1}
                onNavigate={(page) => {
                  const ch = chapters[page - 1];
                  if (ch) navigateToChapter(ch.href);
                }}
                anchorRef={tocAnchorRef}
              />
            </>
          )}

          <button
            ref={settingsAnchorRef}
            onClick={() => { setSettingsOpen((v) => !v); setTocOpen(false); }}
            className={`flex items-center justify-center gap-1 size-9 rounded-lg cursor-pointer transition-colors ${
              settingsOpen ? "text-accent-text" : isStandaloneWindow ? "opacity-60 hover:opacity-100" : "text-text-muted hover:bg-bg-input"
            }`}
          >
            <span className="text-[16px] font-semibold leading-6">A</span>
            <span className="text-[12px] font-semibold leading-4">A</span>
          </button>
          <ReaderSettings
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            anchorRef={settingsAnchorRef}
            settings={readerSettings}
            onSettingsChange={setReaderSettings}
            bookFormat={book.format}
          />

          <Button
            variant="icon"
            size="md"
            active={sidePanel === "bookmarks"}
            onClick={() => togglePanel("bookmarks")}
          >
            <Bookmark size={16} />
          </Button>

          <Button
            variant="icon"
            size="md"
            active={sidePanel === "vocab"}
            onClick={() => togglePanel("vocab")}
          >
            <Languages size={16} />
          </Button>

          <div className="w-px h-6 bg-border mx-1" />

          <button
            onClick={() => togglePanel("ai")}
            className={`flex items-center gap-2 h-8 px-2.5 rounded-lg cursor-pointer transition-colors ${
              sidePanel === "ai"
                ? "text-accent-text"
                : isStandaloneWindow ? "opacity-60 hover:opacity-100" : "hover:bg-bg-input text-text-muted"
            }`}
          >
            <Bot size={16} />
            <span className="text-[14px] font-medium tracking-[-0.15px]">
              {t("reader.aiAssistant")}
            </span>
          </button>
        </div>
      </header>

      {/* Body */}
      <div
        className="flex flex-1 overflow-hidden"
        style={{ backgroundColor: getThemeStyles(readerSettings.theme).body }}
      >
        <div className="flex-1 flex flex-col min-w-0" style={{ backgroundColor: getThemeStyles(readerSettings.theme).body }}>
          <main
            className="flex-1 relative overflow-hidden"
            style={{ backgroundColor: getThemeStyles(readerSettings.theme).body }}
            onContextMenu={handleContextMenu}
            onClick={() => {
              setTocOpen(false);
              setSettingsOpen(false);
              // Clicks inside the iframe (text content) don't bubble out
              // through the sandbox boundary, so this fires only for clicks
              // on the margins/white space around the page — i.e. "anywhere
              // else" from the reader's perspective. Drop the in-iframe text
              // selection so the highlight doesn't linger.
              viewRef.current?.deselect?.();
              setHighlightToolbar(null);
            }}
          >
            <div
              ref={viewerRef}
              className="w-full h-full"
              style={book.format === "pdf" ? { backgroundColor: "#ffffff" } : undefined}
            />
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
            {!bookReady && (
              <div className="absolute inset-0 z-20 bg-bg-surface flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                  <Loader2 size={24} className="animate-spin text-text-muted" />
                  <span className="text-[14px] text-text-muted">{t("reader.preparingBook")}</span>
                </div>
              </div>
            )}
            {canGoBack && (
              <button
                onClick={() => viewRef.current?.history.back()}
                className="absolute bottom-4 left-6 z-20 flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-accent-bg text-accent-text shadow-sm cursor-pointer transition-opacity hover:opacity-80"
              >
                <ArrowLeft size={14} />
                <span className="text-[13px] font-medium">{t("reader.back")}</span>
              </button>
            )}
          </main>

          {/* Bottom progress bar */}
          <footer
            className={`px-page pb-2 pt-0 shrink-0 ${isStandaloneWindow ? "" : "bg-bg-surface"}`}
            style={isStandaloneWindow ? {
              backgroundColor: getThemeStyles(readerSettings.theme).body,
              color: getThemeStyles(readerSettings.theme).text,
            } : undefined}
          >
            <div className="flex flex-col gap-2">
              <div className={`h-px w-full ${isStandaloneWindow ? "opacity-10" : "bg-border"}`} style={isStandaloneWindow ? { backgroundColor: "currentColor" } : undefined}>
                <div
                  className="h-full transition-all"
                  style={{ width: `${progress}%`, backgroundColor: isStandaloneWindow ? "currentColor" : "#9f9fa9", opacity: isStandaloneWindow ? 0.4 : undefined }}
                />
              </div>
              <div className="flex items-center justify-between h-8">
                <span className={`text-[12px] ${isStandaloneWindow ? "opacity-60" : "text-text-muted"}`}>
                  {pageInfo ? t("reader.pageOf", { current: pageInfo.current, total: pageInfo.total }) : `${progress}%`}
                </span>
                {book.format === "pdf" && (
                  <div className="flex items-center gap-1">
                    <Button variant="icon" size="sm" onClick={() => handleZoom(-10)}>
                      <Minus size={12} />
                    </Button>
                    <button
                      type="button"
                      onClick={() => { applyZoom("fit"); setZoom("fit"); }}
                      title={t("reader.zoom.fitTooltip")}
                      className={`text-[12px] font-medium min-w-[36px] px-1 text-center tabular-nums hover:opacity-100 ${isStandaloneWindow ? "opacity-60" : "text-text-muted"} ${zoom === "fit" ? "" : "cursor-pointer"}`}
                    >
                      {zoom === "fit" ? t("reader.zoom.fit") : `${zoom}%`}
                    </button>
                    <Button variant="icon" size="sm" onClick={() => handleZoom(10)}>
                      <Plus size={12} />
                    </Button>
                  </div>
                )}
                <span className={`text-[12px] ${isStandaloneWindow ? "opacity-50" : "text-text-muted"}`}>
                  {pageInfo && pageInfo.total > pageInfo.current
                    ? t("reader.pagesLeft", { count: pageInfo.total - pageInfo.current })
                    : ""}
                </span>
              </div>
            </div>
          </footer>
        </div>

        {sidePanel && (
          <div
            onMouseDown={handleMouseDown}
            className="w-0 relative shrink-0 cursor-col-resize z-10"
          >
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-5 h-7 rounded-md bg-bg-surface border border-border shadow-sm flex items-center justify-center">
              <svg width="6" height="10" viewBox="0 0 6 10" fill="currentColor" className="text-text-muted">
                <circle cx="1" cy="1" r="1" /><circle cx="5" cy="1" r="1" />
                <circle cx="1" cy="5" r="1" /><circle cx="5" cy="5" r="1" />
                <circle cx="1" cy="9" r="1" /><circle cx="5" cy="9" r="1" />
              </svg>
            </div>
          </div>
        )}
        <div ref={panelRef} className={sidePanel ? "shrink-0 h-full" : "hidden"} style={{ width: panelWidth }}>
          <div className={sidePanel === "ai" ? "h-full" : "hidden"}>
            <AiPanel
              bookId={bookId}
              bookTitle={book.title}
              bookAuthor={book.author}
              currentChapter={currentChapterIndex >= 0 && currentChapterIndex < chapters.length ? chapters[currentChapterIndex].title : undefined}
              context={aiContext}
              initialChatId={initialChatId}
              onContextConsumed={() => setAiContext(undefined)}
              onNavigateToCfi={(cfi) => {
                viewRef.current?.goTo(cfi).then(() => {
                  viewRef.current?.addAnnotation({ value: cfi, color: "#c27aff" });
                  setTimeout(() => {
                    viewRef.current?.deleteAnnotation({ value: cfi });
                  }, 3000);
                });
              }}
            />
          </div>
          {sidePanel === "bookmarks" && bookId && (
            <BookmarksPanel
              bookId={bookId}
              onNavigate={navigateToCfi}
              getCurrentCfi={() => currentCfiRef.current}
              getCurrentLabel={() => {
                const idx = currentChapterIndex;
                return idx >= 0 && idx < chapters.length
                  ? chapters[idx].title
                  : t("common.bookmark");
              }}
              getPageFromCfi={() => {
                // foliate-js uses fraction-based progress, not location indices
                // Return page info from current state if available
                return pageInfo?.current ?? null;
              }}
            />
          )}
          {sidePanel === "vocab" && bookId && (
            <DictionaryPanel
              bookId={bookId}
              onNavigate={(cfi) => {
                viewRef.current?.goTo(cfi).then(() => {
                  viewRef.current?.addAnnotation({ value: cfi, color: "#c27aff" });
                  setTimeout(() => {
                    viewRef.current?.deleteAnnotation({ value: cfi });
                  }, 3000);
                });
              }}
              getPageFromCfi={() => pageInfo?.current ?? null}
            />
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
          onAskAI={() => {
            setAiContext({
              text: contextMenu.text,
              cfi: contextMenu.cfiRange,
            });
            setSidePanel("ai");
            setContextMenu(null);
          }}
          onLookup={() => {
            const chapterTitle = currentChapterIndex >= 0 && currentChapterIndex < chapters.length
              ? chapters[currentChapterIndex].title
              : undefined;
            setLookup({
              x: contextMenu.x,
              y: contextMenu.y,
              word: contextMenu.text,
              sentence: contextMenu.sentence,
              bookTitle: book?.title,
              chapter: chapterTitle,
              cfi: contextMenu.cfiRange,
            });
            setContextMenu(null);
          }}
          onTranslate={() => {
            setTranslation({
              x: contextMenu.x,
              y: contextMenu.y,
              text: contextMenu.text,
              context: contextMenu.sentence,
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
              }).catch((err) => console.error("Failed to add highlight:", err));
            }
            setContextMenu(null);
          }}
        />
      )}

      {lookup && (
        <LookupPopover
          x={lookup.x}
          y={lookup.y}
          word={lookup.word}
          sentence={lookup.sentence}
          bookTitle={lookup.bookTitle}
          chapter={lookup.chapter}
          bookId={bookId!}
          cfi={lookup.cfi}
          onClose={() => setLookup(null)}
        />
      )}

      {translation && (
        <TranslationPopover
          x={translation.x}
          y={translation.y}
          text={translation.text}
          context={translation.context}
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
              })
              .catch((err) => console.error("Failed to update highlight color:", err));
          }}
          onDelete={() => {
            invoke("remove_highlight", { id: highlightToolbar.highlightId })
              .then(() => {
                viewRef.current?.deleteAnnotation({ value: highlightToolbar.cfiRange });
                setHighlightToolbar(null);
              })
              .catch((err) => console.error("Failed to remove highlight:", err));
          }}
          onClose={() => setHighlightToolbar(null)}
        />
      )}
    </div>
  );
}
