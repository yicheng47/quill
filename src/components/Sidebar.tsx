import { useState } from "react";
import { Library, BookOpen, CheckCircle2, Sparkles, BookA, Plus, MessageSquare } from "lucide-react";
import Button from "./ui/Button";
import QuillLogo from "./QuillLogo";
import type { Book } from "../hooks/useBooks";
import type { Collection } from "../hooks/useCollections";

interface SidebarProps {
  activeFilter: string;
  onFilterChange: (filter: string) => void;
  books: Book[];
  collections: {
    collections: Collection[];
    create: (name: string) => Promise<Collection>;
  };
}

const libraryFilters = [
  { id: "all", label: "All Books", icon: Library },
  { id: "reading", label: "Currently Reading", icon: BookOpen },
  { id: "finished", label: "Finished", icon: CheckCircle2 },
];

export default function Sidebar({ activeFilter, onFilterChange, books, collections: collectionsHook }: SidebarProps) {
  const { collections, create } = collectionsHook;
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const getCount = (filterId: string) => {
    if (filterId === "all") return books.length;
    if (filterId === "reading") return books.filter((b) => b.status === "reading").length;
    if (filterId === "finished") return books.filter((b) => b.status === "finished").length;
    return 0;
  };

  const handleCreateCollection = async () => {
    const name = newName.trim();
    if (!name) return;
    await create(name);
    setNewName("");
    setIsCreating(false);
  };

  return (
    <aside className="w-[224px] shrink-0 bg-bg-muted border-r border-border h-full flex flex-col gap-6 px-4 relative">
      <div data-tauri-drag-region className="absolute top-0 left-0 right-0 h-11" />
      <div className="flex items-center gap-2.5 pb-2 pt-11">
        <QuillLogo size={28} />
        <span className="text-[18px] font-semibold tracking-[0.5px] text-text-primary" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
          Quill
        </span>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.3px] text-text-muted">
          Library
        </h2>
        <div className="flex flex-col gap-1">
          {libraryFilters.map((filter) => {
            const Icon = filter.icon;
            const isActive = activeFilter === filter.id;
            return (
              <button
                key={filter.id}
                onClick={() => onFilterChange(filter.id)}
                className={`flex items-center justify-between px-3 h-9 rounded-lg w-full cursor-pointer ${
                  isActive ? "bg-accent-bg" : "hover:bg-bg-input"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon
                    size={16}
                    className={isActive ? "text-accent-text" : "text-text-muted"}
                  />
                  <span
                    className={`text-[14px] font-medium tracking-[-0.15px] ${
                      isActive ? "text-accent-text" : "text-text-secondary"
                    }`}
                  >
                    {filter.label}
                  </span>
                </div>
                <span className="text-[12px] font-medium text-text-muted">
                  {getCount(filter.id)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.3px] text-text-muted">
          Tools
        </h2>
        <div className="flex flex-col gap-1">
          <button
            onClick={() => onFilterChange("vocab")}
            className={`flex items-center gap-2 px-3 h-9 rounded-lg w-full cursor-pointer ${
              activeFilter === "vocab" ? "bg-accent-bg" : "hover:bg-bg-input"
            }`}
          >
            <BookA size={16} className={activeFilter === "vocab" ? "text-accent-text" : "text-text-muted"} />
            <span className={`text-[14px] font-medium tracking-[-0.15px] ${
              activeFilter === "vocab" ? "text-accent-text" : "text-text-secondary"
            }`}>
              Vocabulary
            </span>
          </button>
          <button
            onClick={() => onFilterChange("chats")}
            className={`flex items-center gap-2 px-3 h-9 rounded-lg w-full cursor-pointer ${
              activeFilter === "chats" ? "bg-accent-bg" : "hover:bg-bg-input"
            }`}
          >
            <MessageSquare size={16} className={activeFilter === "chats" ? "text-accent-text" : "text-text-muted"} />
            <span className={`text-[14px] font-medium tracking-[-0.15px] ${
              activeFilter === "chats" ? "text-accent-text" : "text-text-secondary"
            }`}>
              Chats
            </span>
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.3px] text-text-muted">
            Collections
          </h2>
          <Button
            variant="icon"
            size="sm"
            className="size-5"
            onClick={() => setIsCreating(true)}
          >
            <Plus size={16} />
          </Button>
        </div>

        {isCreating && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleCreateCollection();
            }}
            className="px-1"
          >
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={() => {
                if (!newName.trim()) setIsCreating(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setNewName("");
                  setIsCreating(false);
                }
              }}
              placeholder="Collection name..."
              className="w-full h-9 px-3 rounded-lg bg-bg-input text-[14px] text-text-primary placeholder:text-text-placeholder outline-none border border-accent"
            />
          </form>
        )}

        <div className="flex flex-col gap-1">
          {collections.map((collection) => {
            const isActive = activeFilter === `collection:${collection.id}`;
            return (
              <button
                key={collection.id}
                onClick={() => onFilterChange(`collection:${collection.id}`)}
                className={`flex items-center justify-between px-3 h-9 rounded-lg w-full cursor-pointer ${
                  isActive ? "bg-accent-bg" : "hover:bg-bg-input"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Sparkles
                    size={16}
                    className={isActive ? "text-accent-text" : "text-text-muted"}
                  />
                  <span
                    className={`text-[14px] font-medium tracking-[-0.15px] ${
                      isActive ? "text-accent-text" : "text-text-secondary"
                    }`}
                  >
                    {collection.name}
                  </span>
                </div>
                <span className="text-[12px] font-medium text-text-muted">
                  {collection.book_count}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
