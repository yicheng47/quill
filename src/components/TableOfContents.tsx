import { useEffect, useCallback, useRef } from "react";

interface Chapter {
  title: string;
  page: number;
}

interface TableOfContentsProps {
  open: boolean;
  onClose: () => void;
  chapters: Chapter[];
  currentPage: number;
  onNavigate: (page: number) => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
}

export default function TableOfContents({
  open,
  onClose,
  chapters,
  currentPage,
  onNavigate,
  anchorRef,
}: TableOfContentsProps) {
  const popoverRef = useRef<HTMLDivElement>(null);

  const positionPopover = useCallback(
    (node: HTMLDivElement | null) => {
      popoverRef.current = node;
      if (!node) return;
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      node.style.top = `${rect.bottom + 8}px`;
      node.style.right = `${window.innerWidth - rect.right}px`;
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
              onClick={() => {
                onNavigate(chapter.page);
                onClose();
              }}
              className={`flex items-center justify-between px-4 py-2 cursor-pointer transition-colors ${
                isActive
                  ? "bg-blue-50"
                  : "hover:bg-border-light"
              }`}
            >
              <span
                className={`text-[14px] font-medium tracking-[-0.15px] truncate ${
                  isActive ? "text-[#155dfc]" : "text-[#3f3f47]"
                }`}
              >
                {chapter.title}
              </span>
              <span
                className={`text-[12px] font-medium shrink-0 ml-2 ${
                  isActive ? "text-[#2b7fff]" : "text-[#9f9fa9]"
                }`}
              >
                p. {chapter.page}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
