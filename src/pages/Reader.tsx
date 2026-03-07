import { useState, useRef, useCallback, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import ePub, { type Book as EpubBook, type Rendition, type NavItem } from "epubjs";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  ArrowLeft,
  BookOpen,
  List,
  Bookmark,
  Bot,
  Loader2,
} from "lucide-react";
import Button from "../components/ui/Button";
import AiPanel from "../components/AiPanel";
import BookmarksPanel from "../components/BookmarksPanel";
import ReaderSettings, { type ReaderSettingsState, getFontFamily, getThemeStyles } from "../components/ReaderSettings";
import ReaderContextMenu from "../components/ReaderContextMenu";
import TableOfContents from "../components/TableOfContents";
import { getBook, updateReadingProgress, type Book } from "../hooks/useBooks";
import { getAllSettings } from "../hooks/useSettings";

const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 700;
const PANEL_DEFAULT_WIDTH = 525;

type SidePanel = "ai" | "bookmarks" | null;

interface TocChapter {
  title: string;
  href: string;
}

export default function Reader() {
  const { bookId } = useParams();
  const navigate = useNavigate();
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
  const [locationsReady, setLocationsReady] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    text: string;
    cfiRange?: string;
  } | null>(null);
  const [aiContext, setAiContext] = useState<string | undefined>();
  const [readerSettings, setReaderSettings] = useState<ReaderSettingsState>({
    theme: "original",
    font: "georgia",
    fontSize: 26,
    brightness: 100,
    lineSpacing: 1.8,
    charSpacing: 0,
    wordSpacing: 0,
    margins: 0,
  });

  const settingsAnchorRef = useRef<HTMLButtonElement>(null);
  const tocAnchorRef = useRef<HTMLButtonElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const epubRef = useRef<EpubBook | null>(null);
  const isDragging = useRef(false);
  const chaptersRef = useRef<TocChapter[]>([]);
  const selectedCfiRef = useRef<string | null>(null);

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
        lineSpacing: s.line_spacing ? parseFloat(s.line_spacing) : prev.lineSpacing,
        charSpacing: s.char_spacing ? parseInt(s.char_spacing) : prev.charSpacing,
        wordSpacing: s.word_spacing ? parseInt(s.word_spacing) : prev.wordSpacing,
        margins: s.margins ? parseInt(s.margins) : prev.margins,
      }));
    }).catch(() => {});
  }, [bookId]);

  // Initialize epub.js when book data is loaded
  useEffect(() => {
    if (!book || !viewerRef.current) return;

    const container = viewerRef.current;
    const { clientWidth, clientHeight } = container;

    const epubUrl = convertFileSrc(book.file_path);
    const epubBook = ePub(epubUrl);
    epubRef.current = epubBook;

    const rendition = epubBook.renderTo(container, {
      width: clientWidth,
      height: clientHeight,
      spread: "none",
      flow: "paginated",
      manager: "continuous",
      allowScriptedContent: true,
    });

    renditionRef.current = rendition;

    // Inject styles into each epub iframe BEFORE column layout.
    // epub.js columns() sets body height to the rendition height and adds
    // 20px padding top + bottom (see contents.js line 1084-1086).
    // In the iframe: 100vh = iframe height = body height (set by epub.js).
    // Available content height = 100vh - 40px (the padding).
    // Images must fit within this to avoid being clipped by CSS columns.
    rendition.hooks.content.register((contents: { document: Document }) => {
      const style = contents.document.createElement("style");
      style.textContent = `
        body { overflow: hidden !important; }
        img, svg, image {
          max-width: 100% !important;
          max-height: calc(100vh - 40px) !important;
          height: auto !important;
          object-fit: contain !important;
          box-sizing: border-box !important;
        }
        figure {
          max-width: 100% !important;
          overflow: hidden !important;
        }
      `;
      contents.document.head.appendChild(style);
    });

    // Display from saved position or start
    if (book.current_cfi) {
      rendition.display(book.current_cfi);
    } else {
      rendition.display();
    }

    // Generate locations for accurate progress tracking and total pages
    // Try to load cached locations first, otherwise generate
    const locationsKey = `locations_${bookId}`;
    epubBook.ready.then(async () => {
      try {
        const cached = localStorage.getItem(locationsKey);
        if (cached) {
          epubBook.locations.load(cached);
        } else {
          await epubBook.locations.generate(1600);
          localStorage.setItem(locationsKey, epubBook.locations.save());
        }
      } catch {
        await epubBook.locations.generate(1600);
        try { localStorage.setItem(locationsKey, epubBook.locations.save()); } catch {}
      }

      const totalPages = epubBook.locations.length();
      if (bookId && totalPages > 0) {
        invoke("update_book_pages", { id: bookId, pages: totalPages }).catch(() => {});
      }
      // Update page info now that locations are available
      const cfi = currentCfiRef.current;
      if (cfi) {
        const currentLoc = epubBook.locations.locationFromCfi(cfi);
        const pct = Math.round(epubBook.locations.percentageFromCfi(cfi) * 100);
        setProgress(pct);
        setPageInfo({ current: currentLoc + 1, total: totalPages });
        if (bookId) {
          updateReadingProgress(bookId, pct, cfi).catch(() => {});
        }
      }
      setLocationsReady(true);
    });

    // Load TOC
    epubBook.loaded.navigation.then((nav) => {
      const flattenToc = (items: NavItem[]): TocChapter[] => {
        const result: TocChapter[] = [];
        for (const item of items) {
          result.push({ title: item.label.trim(), href: item.href });
          if (item.subitems) {
            result.push(...flattenToc(item.subitems));
          }
        }
        return result;
      };
      const chs = flattenToc(nav.toc);
      chaptersRef.current = chs;
      setChapters(chs);
    });

    // Track location changes for progress and page info
    rendition.on("relocated", (location: any) => {
      if (location.start?.cfi) {
        currentCfiRef.current = location.start.cfi;
      }
      const totalLocs = epubBook.locations?.length() || 0;
      if (totalLocs > 0 && location.start?.cfi) {
        const currentLoc = epubBook.locations.locationFromCfi(location.start.cfi);
        const pct = Math.round(epubBook.locations.percentageFromCfi(location.start.cfi) * 100);
        setProgress(pct);
        setPageInfo({ current: currentLoc + 1, total: totalLocs });
        if (bookId) {
          updateReadingProgress(bookId, pct, location.start.cfi).catch(() => {});
        }
      } else {
        // Locations not ready yet, use chapter-level info
        const pct = Math.round((location.start?.percentage ?? 0) * 100);
        setProgress(pct);
        const displayed = location.start?.displayed;
        if (displayed) {
          setPageInfo({ current: displayed.page, total: displayed.total });
        }
        if (bookId) {
          updateReadingProgress(bookId, pct, location.start?.cfi).catch(() => {});
        }
      }
    });

    // Track current chapter index
    rendition.on("rendered", (section: { href: string }) => {
      const idx = chaptersRef.current.findIndex((c) => section.href.includes(c.href) || c.href.includes(section.href));
      if (idx !== -1) setCurrentChapterIndex(idx);
    });

    // Handle text selection for context menu with CFI range
    rendition.on("selected", (cfiRange: string, _contents: any) => {
      // Store the cfiRange so it's available when context menu opens
      selectedCfiRef.current = cfiRange;
    });

    // Keyboard + focus handling inside epub iframes
    const iframeKeyHandler = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") rendition.prev();
      else if (e.key === "ArrowRight") rendition.next();
    };
    // When user clicks inside iframe, pull focus back to parent so
    // the parent document keydown listener works for subsequent keys
    const iframeClickHandler = () => {
      window.focus();
      document.body.focus();
    };
    const iframeContextMenuHandler = function(this: Document, e: MouseEvent) {
      const sel = this.getSelection?.();
      const text = sel?.toString().trim();
      if (text) {
        e.preventDefault();
        e.stopPropagation();
        // e.clientX/Y are relative to iframe viewport
        // Find the iframe element in the parent to get its offset
        const iframes = container.querySelectorAll("iframe");
        let offsetX = 0;
        let offsetY = 0;
        for (const iframe of iframes) {
          if (iframe.contentDocument === this) {
            const rect = iframe.getBoundingClientRect();
            offsetX = rect.left;
            offsetY = rect.top;
            break;
          }
        }
        setContextMenu({
          x: e.clientX + offsetX,
          y: e.clientY + offsetY,
          text,
          cfiRange: selectedCfiRef.current || undefined,
        });
      }
    };
    rendition.hooks.content.register((contents: { document: Document }) => {
      contents.document.addEventListener("keydown", iframeKeyHandler);
      contents.document.addEventListener("click", iframeClickHandler);
      contents.document.addEventListener("contextmenu", iframeContextMenuHandler.bind(contents.document));
    });

    // Resize rendition when container size changes (window resize)
    let resizeTimer: ReturnType<typeof setTimeout>;
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try {
          if (container && renditionRef.current?.manager) {
            renditionRef.current.resize(container.clientWidth, container.clientHeight);
          }
        } catch (_) { /* manager not ready */ }
      }, 100);
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      clearTimeout(resizeTimer);
      rendition.destroy();
      epubBook.destroy();
      renditionRef.current = null;
      epubRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book]);

  // Apply reader settings to epub rendition
  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition) return;

    const themeColors = getThemeStyles(readerSettings.theme);
    const fontFamily = getFontFamily(readerSettings.font);

    const letterSpacing = readerSettings.charSpacing === 0 ? "normal" : `${readerSettings.charSpacing * 0.01}em`;
    const wordSpacing = readerSettings.wordSpacing === 0 ? "normal" : `${readerSettings.wordSpacing * 0.01}em`;
    rendition.themes.default({
      body: {
        "overflow": "hidden !important",
        "background-color": `${themeColors.body} !important`,
        "color": `${themeColors.text} !important`,
        "font-family": `${fontFamily} !important`,
        "font-size": `${readerSettings.fontSize}px !important`,
        "line-height": `${readerSettings.lineSpacing} !important`,
        "letter-spacing": `${letterSpacing} !important`,
        "word-spacing": `${wordSpacing} !important`,
      },
      "p, span, div, li, td, th, h1, h2, h3, h4, h5, h6": {
        "color": `${themeColors.text} !important`,
        "font-family": `${fontFamily} !important`,
        "line-height": `${readerSettings.lineSpacing} !important`,
      },
    });

    // Apply brightness and margins on the viewer container
    if (viewerRef.current) {
      viewerRef.current.style.filter = `brightness(${readerSettings.brightness / 100})`;
    }

    // Resize rendition to account for margins
    setTimeout(() => {
      try {
        if (viewerRef.current && renditionRef.current?.manager) {
          const { clientWidth, clientHeight } = viewerRef.current;
          const marginPx = readerSettings.margins;
          renditionRef.current.resize(clientWidth - marginPx * 2, clientHeight);
          // Center the rendition container
          const container = viewerRef.current.firstElementChild as HTMLElement;
          if (container) {
            container.style.margin = "0 auto";
          }
        }
      } catch (_) { /* manager not ready */ }
    }, 50);
  }, [readerSettings]);

  const togglePanel = (panel: "ai" | "bookmarks") => {
    setSidePanel((prev) => (prev === panel ? null : panel));
  };

  // Resize rendition when side panel opens/closes
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        if (viewerRef.current && renditionRef.current?.manager) {
          const { clientWidth, clientHeight } = viewerRef.current;
          renditionRef.current.resize(clientWidth, clientHeight);
        }
      } catch (_) { /* manager not ready */ }
    }, 100);
    return () => clearTimeout(timer);
  }, [sidePanel]);

  // Keyboard navigation — parent document listener (works when parent has focus)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowLeft") renditionRef.current?.prev();
      else if (e.key === "ArrowRight") renditionRef.current?.next();
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
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        text,
        cfiRange: selectedCfiRef.current || undefined,
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
      // Resize after React re-render settles
      setTimeout(() => {
        if (viewerRef.current && renditionRef.current) {
          const { clientWidth, clientHeight } = viewerRef.current;
          renditionRef.current.resize(clientWidth, clientHeight);
        }
      }, 50);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, []);

  const navigateToChapter = useCallback((href: string) => {
    renditionRef.current?.display(href);
  }, []);

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
          <div className="size-10 rounded-lg bg-[#8b5cf6] flex items-center justify-center">
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
            className="flex-1 overflow-hidden bg-bg-surface relative"
            onContextMenu={handleContextMenu}
            onClick={() => { setTocOpen(false); setSettingsOpen(false); }}
          >
            <div ref={viewerRef} className="w-full h-full overflow-x-hidden" />
            {!locationsReady && (
              <div className="absolute inset-0 z-20 bg-bg-surface flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                  <Loader2 size={24} className="animate-spin text-text-muted" />
                  <span className="text-[14px] text-text-muted">Preparing book...</span>
                </div>
              </div>
            )}
{/* needsRefocus overlay removed — iframe click handler refocuses parent */}
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
        <div ref={panelRef} className={sidePanel ? "shrink-0" : "hidden"} style={{ width: panelWidth }}>
          <div className={sidePanel === "ai" ? "h-full" : "hidden"}>
            <AiPanel context={aiContext} onContextConsumed={() => setAiContext(undefined)} />
          </div>
          {sidePanel === "bookmarks" && bookId && (
            <BookmarksPanel bookId={bookId} />
          )}
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <ReaderContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onCopy={() => {
            navigator.clipboard.writeText(contextMenu.text);
            setContextMenu(null);
          }}
          onHighlight={(color) => {
            const cfiRange = contextMenu.cfiRange;
            if (cfiRange && bookId) {
              invoke("add_highlight", {
                bookId,
                cfiRange,
                color,
                note: null,
                textContent: contextMenu.text,
              }).catch((err) => console.error("Failed to add highlight:", err));
            }
            setContextMenu(null);
          }}
          onAskAI={() => {
            setAiContext(contextMenu.text);
            setSidePanel("ai");
            setContextMenu(null);
          }}
        />
      )}
    </div>
  );
}
