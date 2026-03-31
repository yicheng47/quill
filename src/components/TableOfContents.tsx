import { useEffect, useCallback, useRef } from "react";

interface Chapter {
  title: string;
  page: number;
  depth: number;
}

interface TableOfContentsProps {
  open: boolean;
  onClose: () => void;
  chapters: Chapter[];
  currentPage: number;
  onNavigate: (page: number) => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  alignLeft?: boolean;
}

export default function TableOfContents({
  open,
  onClose,
  chapters,
  currentPage,
  onNavigate,
  anchorRef,
  alignLeft,
}: TableOfContentsProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  const positionPopover = useCallback(
    (node: HTMLDivElement | null) => {
      popoverRef.current = node;
      if (!node) return;
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      node.style.top = `${rect.bottom + 8}px`;
      if (alignLeft) {
        node.style.left = `${rect.left}px`;
      } else {
        node.style.right = `${window.innerWidth - rect.right}px`;
      }
    },
    [anchorRef],
  );

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, onClose, anchorRef]);

  // Auto-scroll to active chapter when opened
  useEffect(() => {
    if (open && activeRef.current) {
      activeRef.current.scrollIntoView({ block: "center" });
    }
  }, [open]);

  if (!open) return null;

  return (
    <div
      ref={positionPopover}
      className="fixed z-50 bg-bg-surface border border-border rounded-xl shadow-popover w-[320px] flex flex-col"
    >
      <div className="border-b border-border-light px-4 pt-3 pb-2">
        <h3 className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">
          Table of Contents
        </h3>
      </div>
      <div className="flex flex-col py-1 overflow-auto max-h-[300px]">
        {chapters.map((chapter) => {
          const isActive = currentPage === chapter.page;
          return (
            <button
              key={chapter.page}
              ref={isActive ? activeRef : undefined}
              onClick={() => {
                onNavigate(chapter.page);
                onClose();
              }}
              style={{ paddingLeft: `${16 + chapter.depth * 16}px` }}
              className={`flex items-center justify-between pr-4 py-2 cursor-pointer transition-colors ${
                isActive
                  ? "bg-accent-bg"
                  : "hover:bg-bg-input"
              }`}
            >
              <span
                className={`text-[14px] font-medium tracking-[-0.15px] truncate ${
                  isActive ? "text-accent-text" : "text-text-secondary"
                }`}
              >
                {chapter.title}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
