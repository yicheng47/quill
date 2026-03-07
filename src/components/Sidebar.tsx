import { Library, BookOpen, CheckCircle2, Sparkles, Plus } from "lucide-react";
import Button from "./ui/Button";
import { mockBooks } from "../data/mockBooks";

interface SidebarProps {
  activeFilter: string;
  onFilterChange: (filter: string) => void;
}

const libraryFilters = [
  { id: "all", label: "All Books", icon: Library },
  { id: "reading", label: "Currently Reading", icon: BookOpen },
  { id: "finished", label: "Finished", icon: CheckCircle2 },
];

export default function Sidebar({ activeFilter, onFilterChange }: SidebarProps) {
  const allGenres = [...new Set(mockBooks.map((b) => b.genre))];

  const getCount = (filterId: string) => {
    if (filterId === "all") return mockBooks.length;
    if (filterId === "reading") return mockBooks.filter((b) => b.status === "reading").length;
    if (filterId === "finished") return mockBooks.filter((b) => b.status === "finished").length;
    return mockBooks.filter((b) => b.genre === filterId).length;
  };

  return (
    <aside className="w-[224px] shrink-0 bg-bg-muted border-r border-border h-full flex flex-col gap-6 px-4 pt-4">
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
                      isActive ? "text-accent-text" : "text-[#3f3f47]"
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
        <div className="flex items-center justify-between">
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.3px] text-text-muted">
            Collections
          </h2>
          <Button variant="icon" size="sm" className="size-5">
            <Plus size={16} />
          </Button>
        </div>
        <div className="flex flex-col gap-1">
          {allGenres.map((genre) => {
            const isActive = activeFilter === genre;
            return (
              <button
                key={genre}
                onClick={() => onFilterChange(genre)}
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
                      isActive ? "text-accent-text" : "text-[#3f3f47]"
                    }`}
                  >
                    {genre}
                  </span>
                </div>
                <span className="text-[12px] font-medium text-text-muted">
                  {getCount(genre)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
