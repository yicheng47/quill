import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";

interface Chapter {
  title: string;
  page: number;
  depth: number;
  disabled?: boolean;
}

interface TableOfContentsProps {
  open: boolean;
  chapters: Chapter[];
  currentPage: number;
  onNavigate: (page: number) => void;
}

interface TocRow extends Chapter {
  parentPage?: number;
  hasChildren: boolean;
}

export default function TableOfContents({
  open,
  chapters,
  currentPage,
  onNavigate,
}: TableOfContentsProps) {
  const { t } = useTranslation();
  const activeRef = useRef<HTMLButtonElement>(null);
  const [expandedPages, setExpandedPages] = useState<Set<number>>(() => new Set());

  const rows = useMemo(() => {
    const result: TocRow[] = [];
    const stack: TocRow[] = [];
    for (const chapter of chapters) {
      while (stack.length > 0 && stack[stack.length - 1].depth >= chapter.depth) {
        stack.pop();
      }
      const parent = stack[stack.length - 1];
      if (parent) parent.hasChildren = true;
      const row: TocRow = { ...chapter, parentPage: parent?.page, hasChildren: false };
      result.push(row);
      stack.push(row);
    }
    return result;
  }, [chapters]);

  const rowsByPage = useMemo(() => new Map(rows.map((row) => [row.page, row])), [rows]);

  const activePathPages = useMemo(() => {
    const path: number[] = [];
    let row = rowsByPage.get(currentPage);
    while (row) {
      path.push(row.page);
      row = row.parentPage ? rowsByPage.get(row.parentPage) : undefined;
    }
    return path;
  }, [currentPage, rowsByPage]);

  const shouldScrollActiveRef = useRef(false);
  const wasOpenRef = useRef(open);

  useEffect(() => {
    if (open && !wasOpenRef.current) shouldScrollActiveRef.current = true;
    wasOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setExpandedPages((prev) => {
      const next = new Set(prev);
      for (const page of activePathPages) next.add(page);
      return next.size === prev.size ? prev : next;
    });
  }, [activePathPages, open]);

  const visibleRows = useMemo(() => rows.filter((row) => {
    let parentPage = row.parentPage;
    while (parentPage) {
      if (!expandedPages.has(parentPage)) return false;
      parentPage = rowsByPage.get(parentPage)?.parentPage;
    }
    return true;
  }), [expandedPages, rows, rowsByPage]);

  useEffect(() => {
    if (!open || !activeRef.current || !shouldScrollActiveRef.current) return;
    shouldScrollActiveRef.current = false;
    requestAnimationFrame(() => activeRef.current?.scrollIntoView({ block: "center" }));
  }, [open, visibleRows]);

  if (!open) return null;

  const toggleRow = (page: number) => {
    setExpandedPages((prev) => {
      const next = new Set(prev);
      if (next.has(page)) next.delete(page);
      else next.add(page);
      return next;
    });
  };

  return (
    <aside
      aria-label={t("reader.tocTitle")}
      className="w-80 shrink-0 h-full bg-bg-muted border-r border-border flex flex-col"
    >
      <div className="shrink-0 border-b border-border px-5 py-3 bg-bg-surface">
        <h2 className="text-[15px] font-semibold text-text-primary leading-5">
          {t("reader.tocTitle")}
        </h2>
        <p className="text-[12px] text-text-muted leading-4 mt-0.5">
          {t("reader.tocCount", { count: chapters.length })}
        </p>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
        <div className="flex flex-col gap-1">
          {visibleRows.map((chapter) => {
            const isActive = currentPage === chapter.page;
            const isExpanded = expandedPages.has(chapter.page);
            const rowClassName = [
              "relative flex w-full min-w-0 items-start rounded-md pr-3 py-2 text-left transition-colors",
              isActive ? "bg-accent-bg" : chapter.disabled ? "" : "hover:bg-bg-input",
            ].join(" ");
            const labelClassName = [
              "block text-[13px] leading-5 break-words text-left",
              chapter.disabled ? "opacity-50 cursor-default" : "cursor-pointer",
              isActive
                ? "font-semibold text-accent-text"
                : chapter.depth === 0
                  ? "font-medium text-text-primary"
                  : "font-normal text-text-secondary",
            ].join(" ");

            return (
              <div
                key={chapter.page + "-" + chapter.title}
                style={{ paddingLeft: 4 + chapter.depth * 16 }}
                className={rowClassName}
              >
                {isActive && (
                  <span className="absolute left-0 top-1 bottom-1 w-0.5 rounded-full bg-accent" />
                )}
                {chapter.hasChildren ? (
                  <button
                    type="button"
                    onClick={() => toggleRow(chapter.page)}
                    aria-label={t(isExpanded ? "reader.tocCollapseSection" : "reader.tocExpandSection")}
                    aria-expanded={isExpanded}
                    className="mt-0.5 mr-1 flex size-4 shrink-0 items-center justify-center rounded text-text-muted hover:bg-bg-input"
                  >
                    <ChevronRight size={14} className={isExpanded ? "rotate-90 transition-transform" : "transition-transform"} />
                  </button>
                ) : (
                  <span className="mr-1 size-4 shrink-0" />
                )}
                <button
                  ref={isActive ? activeRef : undefined}
                  type="button"
                  onClick={() => {
                    if (!chapter.disabled) onNavigate(chapter.page);
                  }}
                  disabled={chapter.disabled}
                  title={chapter.title}
                  className="min-w-0 flex-1"
                >
                  <span className={labelClassName}>{chapter.title}</span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
