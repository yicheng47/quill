import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, X } from "lucide-react";

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
  onClose?: () => void;
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
  onClose,
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

  const visibleRows = useMemo(
    () =>
      rows.filter((row) => {
        let parentPage = row.parentPage;
        while (parentPage) {
          if (!expandedPages.has(parentPage)) return false;
          parentPage = rowsByPage.get(parentPage)?.parentPage;
        }
        return true;
      }),
    [expandedPages, rows, rowsByPage],
  );

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
      className="w-[300px] max-w-[calc(100%-256px)] shrink-0 h-full reader-island rounded-[24px] p-[18px] flex flex-col gap-3.5"
    >
      <div className="shrink-0 flex items-center justify-between px-1 py-0.5">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-text-primary leading-[19px]">
            {t("reader.tocTitle")}
          </h2>
          <p className="text-[12px] text-text-tertiary leading-4 mt-0.5">
            {t("reader.tocCount", { count: chapters.length })}
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t("reader.tocClose")}
            className="size-7 rounded-control flex items-center justify-center text-text-secondary hover:bg-border-subtle cursor-pointer transition-colors shrink-0"
          >
            <X size={14} />
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-0.5">
        {visibleRows.map((chapter, index) => {
          const isActive = currentPage === chapter.page;
          const isExpanded = expandedPages.has(chapter.page);
          const showPartDivider = index > 0 && chapter.depth === 0;
          const rowClassName = [
            "flex w-full min-w-0 items-start rounded-[8px] py-[7px] pr-2.5 text-left transition-colors",
            isActive ? "bg-accent-tint" : chapter.disabled ? "" : "hover:bg-border-subtle",
          ].join(" ");
          const labelClassName = [
            "block text-[13px] leading-[17px] break-words text-left",
            chapter.disabled ? "opacity-50 cursor-default" : "cursor-pointer",
            isActive
              ? "font-semibold text-accent-on-tint"
              : chapter.depth === 0
                ? "font-semibold text-text-primary"
                : "font-normal text-text-secondary",
          ].join(" ");

          return (
            <div key={chapter.page + "-" + chapter.title}>
              {showPartDivider && (
                <div className="px-2 pt-2 pb-1">
                  <div className="h-px bg-border-subtle" />
                </div>
              )}
              <div
                style={{ paddingLeft: 8 + chapter.depth * 16 }}
                className={rowClassName}
              >
                {chapter.hasChildren && (
                  <button
                    type="button"
                    onClick={() => toggleRow(chapter.page)}
                    aria-label={t(isExpanded ? "reader.tocCollapseSection" : "reader.tocExpandSection")}
                    aria-expanded={isExpanded}
                    className="mt-0.5 mr-1.5 flex size-4 shrink-0 items-center justify-center rounded text-text-tertiary hover:text-text-primary cursor-pointer"
                  >
                    <ChevronRight
                      size={14}
                      className={isExpanded ? "rotate-90 transition-transform" : "transition-transform"}
                    />
                  </button>
                )}
                {isActive && (
                  <span className="w-[3px] h-3.5 rounded-[2px] bg-accent shrink-0 mt-[2px] mr-2" />
                )}
                <button
                  ref={isActive ? activeRef : undefined}
                  type="button"
                  onClick={() => {
                    if (!chapter.disabled) onNavigate(chapter.page);
                  }}
                  disabled={chapter.disabled}
                  title={chapter.title}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className={labelClassName}>{chapter.title}</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
