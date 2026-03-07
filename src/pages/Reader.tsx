import { useState, useRef, useCallback, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { mockBooks } from "../data/mockBooks";
import {
  ArrowLeft,
  BookOpen,
  List,
  Bookmark,
  Bot,
  GripVertical,
} from "lucide-react";
import Button from "../components/ui/Button";
import AiPanel from "../components/AiPanel";
import BookmarksPanel from "../components/BookmarksPanel";
import ReaderSettings from "../components/ReaderSettings";
import ReaderContextMenu from "../components/ReaderContextMenu";
import TableOfContents from "../components/TableOfContents";

const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 700;
const PANEL_DEFAULT_WIDTH = 525;

const MOCK_CHAPTERS = [
  { title: "Chapter 1: The Beginning", page: 1 },
  { title: "Chapter 2: The Discovery", page: 2 },
  { title: "Chapter 3: The Choice", page: 3 },
];

type SidePanel = "ai" | "bookmarks" | null;
type SlidePhase = "left" | "right" | "enter-from-left" | "enter-from-right" | null;

function getSlideStyle(phase: SlidePhase): React.CSSProperties {
  switch (phase) {
    case "left":
      return { transition: "transform 200ms ease-in", transform: "translateX(-100%)" };
    case "right":
      return { transition: "transform 200ms ease-in", transform: "translateX(100%)" };
    case "enter-from-left":
      return { transition: "none", transform: "translateX(-100%)" };
    case "enter-from-right":
      return { transition: "none", transform: "translateX(100%)" };
    default:
      return { transition: "transform 200ms ease-out", transform: "translateX(0)" };
  }
}

export default function Reader() {
  const { bookId } = useParams();
  const navigate = useNavigate();
  const book = mockBooks.find((b) => b.id === bookId);
  const [sidePanel, setSidePanel] = useState<SidePanel>(null);
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT_WIDTH);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const totalPages = MOCK_CHAPTERS.length;
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);
  const [turnDirection, setTurnDirection] = useState<SlidePhase>(null);
  const [animating, setAnimating] = useState(false);
  const settingsAnchorRef = useRef<HTMLButtonElement>(null);
  const tocAnchorRef = useRef<HTMLButtonElement>(null);
  const isDragging = useRef(false);

  const togglePanel = (panel: "ai" | "bookmarks") => {
    setSidePanel((prev) => (prev === panel ? null : panel));
  };

  const turnPage = useCallback(
    (direction: "left" | "right") => {
      const nextPage =
        direction === "left"
          ? Math.max(1, currentPage - 1)
          : Math.min(totalPages, currentPage + 1);
      if (nextPage === currentPage) return;

      // Phase 1: slide current page out
      setTurnDirection(direction);
      setAnimating(true);

      // Phase 2: after slide-out, swap page instantly at offscreen position, then slide in
      setTimeout(() => {
        setCurrentPage(nextPage);
        // Jump to the opposite side (offscreen) without transition
        setTurnDirection(direction === "left" ? "enter-from-right" : "enter-from-left");

        // Phase 3: slide in from opposite side
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setTurnDirection(null);
            setAnimating(false);
          });
        });
      }, 200);
    },
    [currentPage, totalPages],
  );

  // Keyboard navigation: left/right arrow keys for page turning
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (animating) return;

      if (e.key === "ArrowLeft") {
        turnPage("left");
      } else if (e.key === "ArrowRight") {
        turnPage("right");
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [turnPage, animating]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (text) {
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, text });
    }
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    const startX = e.clientX;
    const startWidth = panelWidth;

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = startX - e.clientX;
      const newWidth = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, startWidth + delta));
      setPanelWidth(newWidth);
    };

    const handleMouseUp = () => {
      isDragging.current = false;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [panelWidth]);

  if (!book) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p>Book not found</p>
      </div>
    );
  }

  const currentChapter = MOCK_CHAPTERS.find((c) => c.page === currentPage);
  const pagesLeftInChapter = totalPages - currentPage;

  return (
    <div className="flex flex-col h-screen bg-bg-page">
      {/* Header */}
      <header className="flex items-center justify-between px-section h-14 bg-bg-surface border-b border-border shrink-0">
        {/* Left: back + title */}
        <div className="flex items-center gap-3">
          <Button variant="icon" size="md" onClick={() => navigate("/")}>
            <ArrowLeft size={16} />
          </Button>
          <div className="w-px h-6 bg-border" />
          <BookOpen size={20} className="text-text-muted" />
          <h1 className="text-[24px] font-semibold text-text-primary tracking-[0.07px] whitespace-nowrap">
            {book.title}
          </h1>
        </div>

        {/* Right: TOC + Aa + Bookmark + AI */}
        <div className="flex items-center">
          {/* Table of Contents */}
          <Button
            ref={tocAnchorRef}
            variant="icon"
            size="md"
            onClick={() => setTocOpen((v) => !v)}
          >
            <List size={16} />
          </Button>
          <TableOfContents
            open={tocOpen}
            onClose={() => setTocOpen(false)}
            chapters={MOCK_CHAPTERS}
            currentPage={currentPage}
            onNavigate={setCurrentPage}
            anchorRef={tocAnchorRef}
          />

          {/* Font settings */}
          <button
            ref={settingsAnchorRef}
            onClick={() => setSettingsOpen((v) => !v)}
            className="flex items-center gap-1 h-8 px-2 rounded-lg hover:bg-bg-input cursor-pointer"
          >
            <span className="text-[16px] font-semibold text-text-body leading-6">A</span>
            <span className="text-[12px] font-semibold text-text-body leading-4">A</span>
          </button>
          <ReaderSettings
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            anchorRef={settingsAnchorRef}
          />

          {/* Bookmark toggle */}
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

          {/* AI Assistant toggle */}
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

      {/* Body: reading area + optional side panel */}
      <div className="flex flex-1 overflow-hidden">
        {/* Reading content */}
        <div className="flex-1 flex flex-col min-w-0">
          <main className="flex-1 overflow-x-hidden overflow-y-auto bg-bg-surface" onContextMenu={handleContextMenu}>
            <div
              className="max-w-[700px] mx-auto px-4 pt-12 pb-16"
              style={getSlideStyle(turnDirection)}
            >
              <h2 className="text-[24px] font-medium text-text-body tracking-[0.07px] leading-9 mb-0">
                {currentChapter?.title ?? "Chapter"}
              </h2>
              <div className="text-[16px] leading-[1.8] text-text-body tracking-[-0.31px]">
                <p>
                  In the year 2025, humanity stood at the precipice of a new era. The convergence of artificial
                  intelligence, quantum computing, and biotechnology had ushered in possibilities that previous
                  generations could only dream of. This is the story of those who dared to push the boundaries
                  of what was possible.
                </p>
                <p>
                  Dr. Sarah Chen gazed out of her laboratory window, watching the city lights flicker in the
                  distance. For years, she had been working on a breakthrough that could change everything.
                  Her research into neural interfaces promised to bridge the gap between human consciousness
                  and machine intelligence in ways never before imagined.
                </p>
                <p>
                  "The question isn't whether we can do it," she often told her colleagues, "but whether we should.
                  Every technological advancement carries with it profound ethical implications."
                </p>
                <p>
                  As she turned back to her workstation, the screens displayed complex patterns of neural
                  activity. The data was beautiful in its complexity — millions of connections forming and dissolving
                  in real-time, a digital representation of thought itself.
                </p>
                <p>
                  Her assistant, Marcus, entered the lab with his usual enthusiasm. "Doctor, you need to see
                  the latest results. The synchronization rate has improved by fifteen percent overnight."
                </p>
                <p>
                  Sarah's eyes widened. This was the breakthrough they had been waiting for. But with it came
                  a weight of responsibility she felt deeply in her bones.
                </p>
              </div>
            </div>
          </main>

          {/* Bottom progress bar */}
          <footer className="bg-bg-surface px-page pb-2 pt-0 shrink-0">
            <div className="flex flex-col gap-2">
              <div className="h-px bg-border w-full">
                <div
                  className="h-full bg-[#9f9fa9] transition-all"
                  style={{ width: `${(currentPage / totalPages) * 100}%` }}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-text-muted">
                  {currentPage} of {totalPages}
                </span>
                <span className="text-[12px] text-text-muted">
                  {pagesLeftInChapter} page{pagesLeftInChapter !== 1 ? "s" : ""} left in chapter
                </span>
              </div>
            </div>
          </footer>
        </div>

        {/* Resizable handle + Side Panel */}
        {sidePanel && (
          <>
            <div
              onMouseDown={handleMouseDown}
              className="w-3 bg-transparent flex items-center justify-center relative shrink-0 cursor-col-resize hover:bg-black/5 transition-colors"
            >
              <div className="bg-black/10 border border-black/10 rounded-sm w-3 h-4 flex items-center justify-center pointer-events-none">
                <GripVertical size={10} className="text-black/40" />
              </div>
            </div>
            <div className="shrink-0" style={{ width: panelWidth }}>
              {sidePanel === "ai" && <AiPanel />}
              {sidePanel === "bookmarks" && <BookmarksPanel />}
            </div>
          </>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <ReaderContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          selectedText={contextMenu.text}
          onClose={() => setContextMenu(null)}
          onCopy={() => {
            navigator.clipboard.writeText(contextMenu.text);
            setContextMenu(null);
          }}
          onHighlight={() => {
            setContextMenu(null);
          }}
          onAddNote={() => {
            setContextMenu(null);
          }}
          onSearchInBook={() => {
            setContextMenu(null);
          }}
          onAskAI={() => {
            setSidePanel("ai");
            setContextMenu(null);
          }}
        />
      )}
    </div>
  );
}
