import { useState, useRef, useCallback, useEffect } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  ArrowLeft,
  BookOpen,
  List,
  Bookmark,
  Bot,
  Languages,
  Loader2,
} from "lucide-react";
import Button from "../components/ui/Button";
import AiPanel from "../components/AiPanel";
import BookmarksPanel from "../components/BookmarksPanel";
import ReaderSettings, { type ReaderSettingsState, getFontFamily, getThemeStyles } from "../components/ReaderSettings";
import ReaderContextMenu from "../components/ReaderContextMenu";
import HighlightToolbar from "../components/HighlightToolbar";
import LookupPopover from "../components/LookupPopover";
import VocabPanel from "../components/VocabPanel";
import TableOfContents from "../components/TableOfContents";
import { getBook, updateReadingProgress, type Book } from "../hooks/useBooks";
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
  getCFI(index: number, range: Range): string;
  addAnnotation(annotation: { value: string; color?: string }): Promise<any>;
  deleteAnnotation(annotation: { value: string }): Promise<void>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

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
}

const highlightColorMap: Record<string, string> = {
  yellow: "rgba(251, 191, 36, 0.5)",
  green: "rgba(52, 211, 153, 0.5)",
  blue: "rgba(96, 165, 250, 0.5)",
  pink: "rgba(244, 114, 182, 0.5)",
  purple: "rgba(167, 139, 250, 0.5)",
};

export default function Reader() {
  const { bookId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [book, setBook] = useState<Book | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidePanel, setSidePanel] = useState<SidePanel>(null);
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT_WIDTH);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [chapters, setChapters] = useState<TocChapter[]>([]);
  const [currentChapterIndex, setCurrentChapterIndex] = useState(-1);
  const [progress, setProgress] = useState(0);
  const [pageInfo, setPageInfo] = useState<{ current: number; total: number } | null>(null);
  const currentCfiRef = useRef<string | null>(null);
  const [bookReady, setBookReady] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    text: string;
    sentence: string;
    cfiRange?: string;
  } | null>(null);
  const [aiContext, setAiContext] = useState<string | undefined>();
  const [lookup, setLookup] = useState<{
    x: number;
    y: number;
    word: string;
    sentence: string;
    bookTitle?: string;
    chapter?: string;
    cfi?: string;
  } | null>(null);
  const [highlightToolbar, setHighlightToolbar] = useState<{
    x: number;
    y: number;
    highlightId: string;
    cfiRange: string;
    color: string;
  } | null>(null);
  const [readerSettings, setReaderSettings] = useState<ReaderSettingsState>({
    theme: "original",
    font: "georgia",
    fontSize: 26,
    brightness: 100,
    readingMode: "scrolling",
    lineSpacing: 1.8,
    charSpacing: 0,
    wordSpacing: 0,
    margins: 0,
  });

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
      .then((b) => setBook(b))
      .catch(() => setBook(null))
      .finally(() => setLoading(false));

    getAllSettings().then((s) => {
      setReaderSettings((prev) => ({
        ...prev,
        font: (s.font_family as ReaderSettingsState["font"]) || prev.font,
        fontSize: s.font_size ? parseInt(s.font_size) : prev.fontSize,
        readingMode: (s.reading_mode as ReaderSettingsState["readingMode"]) || prev.readingMode,
        lineSpacing: s.line_spacing ? parseFloat(s.line_spacing) : prev.lineSpacing,
        charSpacing: s.char_spacing ? parseInt(s.char_spacing) : prev.charSpacing,
        wordSpacing: s.word_spacing ? parseInt(s.word_spacing) : prev.wordSpacing,
        margins: s.margins ? parseInt(s.margins) : prev.margins,
      }));
    }).catch(() => {});
  }, [bookId]);

  // Initialize foliate-js when book data is loaded
  useEffect(() => {
    if (!book || !viewerRef.current) return;

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
      container.appendChild(view);
      viewRef.current = view;

      // Fetch EPUB as blob for foliate-js
      const epubUrl = convertFileSrc(book.file_path);
      const response = await fetch(epubUrl);
      const blob = new File([await response.blob()], "book.epub");
      await view.open(blob);

      if (cancelled) return;

      // Set reading mode and layout
      const isScrolling = readerSettings.readingMode === "scrolling";
      view.renderer.setAttribute("flow", isScrolling ? "scrolled" : "paginated");
      view.renderer.setAttribute("gap", "5%");
      view.renderer.setAttribute("max-inline-size", "1000px");
      view.renderer.setAttribute("max-column-count", "2");

      // Apply styles
      view.renderer.setStyles?.(getReaderCSS(readerSettings));

      // Load TOC
      const toc = view.book.toc;
      if (toc) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const flattenToc = (items: any[]): TocChapter[] =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          items.flatMap((item: any) => [
            { title: item.label?.trim() || "", href: item.href },
            ...(item.subitems ? flattenToc(item.subitems) : []),
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
          const sel = doc.getSelection?.();
          const text = sel?.toString().trim();
          if (text) {
            ev.preventDefault();
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
          if (ev.key === "ArrowLeft") view.prev();
          else if (ev.key === "ArrowRight") view.next();
        });

        // Click to dismiss context menu
        doc.addEventListener("click", () => {
          setContextMenu(null);
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
        // Overlayer is already loaded as a dependency of view.js
        // The draw function accepts a static method and options
        const color = highlightColorMap[annotation.color] || highlightColorMap.yellow;
        // Use the highlight draw function: filled rectangles over text ranges
        draw((rects: DOMRectList) => {
          const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
          g.setAttribute("fill", color);
          g.style.mixBlendMode = "multiply";
          for (const { left, top, height, width } of rects) {
            const el = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            el.setAttribute("x", String(left));
            el.setAttribute("y", String(top));
            el.setAttribute("height", String(height));
            el.setAttribute("width", String(width));
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

      // Navigate to saved position
      const startCfi = book.current_cfi;
      await view.init({ lastLocation: startCfi || undefined, showTextStart: !startCfi });

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
      if (viewRef.current) {
        viewRef.current.close();
        viewRef.current.remove();
        viewRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book]);

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

    // Update max-inline-size for margins (narrower content = more margin)
    const baseWidth = 1000;
    const marginOffset = readerSettings.margins * 2;
    view.renderer.setAttribute("max-inline-size", `${Math.max(400, baseWidth - marginOffset)}px`);

    // Update brightness
    if (viewerRef.current) {
      viewerRef.current.style.filter = `brightness(${readerSettings.brightness / 100})`;
    }
  }, [readerSettings]);

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
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

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

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = startX - e.clientX;
      const newWidth = Math.min(
        PANEL_MAX_WIDTH,
        Math.max(PANEL_MIN_WIDTH, startWidth + delta)
      );
      if (panelRef.current) {
        panelRef.current.style.width = `${newWidth}px`;
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      isDragging.current = false;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const delta = startX - e.clientX;
      const finalWidth = Math.min(
        PANEL_MAX_WIDTH,
        Math.max(PANEL_MIN_WIDTH, startWidth + delta)
      );
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

  // Handle navigation state from VocabPage ("Open in Reader")
  useEffect(() => {
    const state = location.state as { openVocab?: boolean; cfi?: string } | null;
    if (!state?.openVocab || !bookReady) return;
    setSidePanel("vocab");
    if (state.cfi) {
      const cfi = state.cfi;
      viewRef.current?.goTo(cfi).then(() => {
        viewRef.current?.addAnnotation({ value: cfi, color: "#c27aff" });
        setTimeout(() => {
          viewRef.current?.deleteAnnotation({ value: cfi });
        }, 3000);
      });
    }
    // Clear the state so it doesn't re-trigger
    navigate(location.pathname, { replace: true });
  }, [bookReady, location.state, location.pathname, navigate]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-text-muted">Loading...</p>
      </div>
    );
  }

  if (!book) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p>Book not found</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-bg-page">
      {/* Invisible overlay to close popovers when clicking anywhere */}
      {(tocOpen || settingsOpen) && (
        <div
          className="fixed inset-0 z-40"
          onMouseDown={(e) => { e.preventDefault(); setTocOpen(false); setSettingsOpen(false); }}
        />
      )}
      {/* Header */}
      <header className="flex items-center justify-between px-section h-14 bg-bg-surface border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <Button variant="icon" size="md" onClick={() => navigate("/")}>
            <ArrowLeft size={16} />
          </Button>
          <div className="w-px h-6 bg-border" />
          <div className="size-10 rounded-lg bg-accent flex items-center justify-center">
            <BookOpen size={18} className="text-white" />
          </div>
          <div className="flex flex-col">
            <h1 className="text-[16px] font-semibold text-text-primary leading-5">
              {book.title}
            </h1>
            <span className="text-[13px] text-text-muted leading-4">
              {chapters.length > 0 ? `Chapter ${currentChapterIndex + 1} of ${chapters.length}` : ""}
            </span>
          </div>
        </div>

        <div className="flex items-center">
          <Button
            ref={tocAnchorRef}
            variant="icon"
            size="md"
            onClick={() => { setTocOpen((v) => !v); setSettingsOpen(false); }}
          >
            <List size={16} />
          </Button>
          <TableOfContents
            open={tocOpen}
            onClose={() => setTocOpen(false)}
            chapters={chapters.map((c, i) => ({ title: c.title, page: i + 1 }))}
            currentPage={currentChapterIndex + 1}
            onNavigate={(page) => {
              const ch = chapters[page - 1];
              if (ch) navigateToChapter(ch.href);
            }}
            anchorRef={tocAnchorRef}
          />

          <button
            ref={settingsAnchorRef}
            onClick={() => { setSettingsOpen((v) => !v); setTocOpen(false); }}
            className="flex items-center gap-1 h-8 px-2 rounded-lg hover:bg-bg-input cursor-pointer"
          >
            <span className="text-[16px] font-semibold text-text-body leading-6">
              A
            </span>
            <span className="text-[12px] font-semibold text-text-body leading-4">
              A
            </span>
          </button>
          <ReaderSettings
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            anchorRef={settingsAnchorRef}
            settings={readerSettings}
            onSettingsChange={setReaderSettings}
          />

          {sidePanel === "bookmarks" ? (
            <Button
              variant="icon"
              size="md"
              active
              onClick={() => togglePanel("bookmarks")}
            >
              <Bookmark size={16} className="text-white" />
            </Button>
          ) : (
            <Button
              variant="icon"
              size="md"
              onClick={() => togglePanel("bookmarks")}
            >
              <Bookmark size={16} className="text-text-body" />
            </Button>
          )}

          {sidePanel === "vocab" ? (
            <Button
              variant="icon"
              size="md"
              active
              onClick={() => togglePanel("vocab")}
            >
              <Languages size={16} className="text-white" />
            </Button>
          ) : (
            <Button
              variant="icon"
              size="md"
              onClick={() => togglePanel("vocab")}
            >
              <Languages size={16} className="text-text-body" />
            </Button>
          )}

          <div className="w-px h-6 bg-border mx-1" />

          {sidePanel === "ai" ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => togglePanel("ai")}
            >
              <Bot size={16} />
              AI Assistant
            </Button>
          ) : (
            <button
              onClick={() => togglePanel("ai")}
              className="flex items-center gap-2 h-8 px-2.5 rounded-lg hover:bg-bg-input cursor-pointer"
            >
              <Bot size={16} className="text-text-body" />
              <span className="text-[14px] font-medium text-text-body tracking-[-0.15px]">
                AI Assistant
              </span>
            </button>
          )}
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 flex flex-col min-w-0">
          <main
            className="flex-1 bg-bg-surface relative overflow-hidden"
            onContextMenu={handleContextMenu}
            onClick={() => { setTocOpen(false); setSettingsOpen(false); }}
          >
            <div
              ref={viewerRef}
              className="w-full h-full"
            />
            {!bookReady && (
              <div className="absolute inset-0 z-20 bg-bg-surface flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                  <Loader2 size={24} className="animate-spin text-text-muted" />
                  <span className="text-[14px] text-text-muted">Preparing book...</span>
                </div>
              </div>
            )}
          </main>

          {/* Bottom progress bar */}
          <footer className="bg-bg-surface px-page pb-2 pt-0 shrink-0">
            <div className="flex flex-col gap-2">
              <div className="h-px bg-border w-full">
                <div
                  className="h-full bg-[#9f9fa9] transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-text-muted">
                  {pageInfo ? `Page ${pageInfo.current} of ${pageInfo.total}` : `${progress}%`}
                </span>
                <span className="text-[12px] text-text-muted">
                  {pageInfo && pageInfo.total > pageInfo.current
                    ? `${pageInfo.total - pageInfo.current} page${pageInfo.total - pageInfo.current !== 1 ? "s" : ""} left`
                    : ""}
                </span>
              </div>
            </div>
          </footer>
        </div>

        {sidePanel && (
          <div
            onMouseDown={handleMouseDown}
            className="w-1.5 bg-transparent flex items-center justify-center relative shrink-0 cursor-col-resize hover:bg-black/5 transition-colors"
          >
          </div>
        )}
        <div ref={panelRef} className={sidePanel ? "shrink-0 h-full" : "hidden"} style={{ width: panelWidth }}>
          <div className={sidePanel === "ai" ? "h-full" : "hidden"}>
            <AiPanel context={aiContext} onContextConsumed={() => setAiContext(undefined)} />
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
                  : "Bookmark";
              }}
              getPageFromCfi={() => {
                // foliate-js uses fraction-based progress, not location indices
                // Return page info from current state if available
                return pageInfo?.current ?? null;
              }}
            />
          )}
          {sidePanel === "vocab" && bookId && (
            <VocabPanel
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
            setAiContext(contextMenu.text);
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
