import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  BookOpen,
  Check,
  Cloud,
  Languages,
  MessageSquare,
  Plus,
  Sparkles,
  StickyNote,
  Upload,
} from "lucide-react";
import type { Book } from "../hooks/useBooks";
import type { Collection } from "../hooks/useCollections";
import type { Highlight } from "../hooks/useBookmarks";
import type { DictionaryWord } from "../hooks/useDictionary";
import type { ChatSummary } from "../hooks/useChats";
import type { MainNavigateOptions, MainRoute } from "./TopBar";
import type { SettingsSection } from "./settings/types";
import { invoke } from "../platform";
import { openReaderWindow } from "../utils/openReaderWindow";
import { getHighlightColorMeta } from "../utils/highlightColors";
import { shouldSuppressSelectionClick } from "../utils/selection";
import { isMacOS, shortcutModSymbol } from "../lib/platformEnv";
import QuillLogo from "./QuillLogo";
import BookCover from "./ui/BookCover";
import Chip from "./ui/Chip";

interface ChatPage {
  chats: ChatSummary[];
  next_cursor: string | null;
  total: number;
}

interface HomeViewProps {
  books: Book[];
  totalBooksCount: number;
  booksLoading: boolean;
  collections: Collection[];
  onNavigate: (route: MainRoute, options?: MainNavigateOptions) => void;
  onImport: () => void;
  onOpenSettings: (section?: SettingsSection) => void;
}

function formatReadingTimeLeft(
  pages: number | null | undefined,
  progress: number,
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  if (!pages || pages <= 0 || progress >= 100) return null;
  const pct = Math.max(0, Math.min(100, progress));
  const remainingMinutes = Math.max(1, Math.round(pages * ((100 - pct) / 100) * 1.5));
  if (remainingMinutes >= 60) {
    return t("home.hoursLeft", { count: Math.max(1, Math.round(remainingMinutes / 60)) });
  }
  return t("home.minutesLeft", { count: remainingMinutes });
}

export default function HomeView({
  books,
  totalBooksCount,
  booksLoading,
  collections,
  onNavigate,
  onImport,
  onOpenSettings,
}: HomeViewProps) {
  const { t } = useTranslation();
  const mod = shortcutModSymbol();
  const isMac = isMacOS();

  const [latestHighlight, setLatestHighlight] = useState<Highlight | null>(null);
  const [recentWords, setRecentWords] = useState<DictionaryWord[]>([]);
  const [wordsCount, setWordsCount] = useState(0);
  const [lastChat, setLastChat] = useState<ChatSummary | null>(null);
  const bentoRequestIdRef = useRef(0);

  const booksById = useMemo(() => {
    const map = new Map<string, Book>();
    for (const book of books) map.set(book.id, book);
    return map;
  }, [books]);

  const sortedByRecent = useMemo(
    () => [...books].sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id)),
    [books],
  );

  const nowReadingBook = useMemo(() => {
    if (sortedByRecent.length === 0) return null;
    return sortedByRecent.find((b) => b.status === "reading") ?? sortedByRecent[0];
  }, [sortedByRecent]);

  const alsoReadingBooks = useMemo(() => {
    if (!nowReadingBook) return [];
    return sortedByRecent
      .filter((b) => b.status === "reading" && b.id !== nowReadingBook.id)
      .slice(0, 2);
  }, [sortedByRecent, nowReadingBook]);

  const shelfBooks = useMemo(() => books.slice(0, 5), [books]);

  const fetchBentoDetails = useCallback(async () => {
    const requestId = ++bentoRequestIdRef.current;
    if (totalBooksCount === 0 && books.length === 0) {
      setLatestHighlight(null);
      setRecentWords([]);
      setWordsCount(0);
      setLastChat(null);
      return;
    }

    const targetBookId = nowReadingBook?.id ?? null;
    const [hlRes, wordsRes, chatsRes] = await Promise.all([
      targetBookId
        ? invoke<Highlight[]>("list_all_highlights", {
            bookId: targetBookId,
            search: null,
            sort: null,
          }).catch(() => null)
        : Promise.resolve(null),
      invoke<DictionaryWord[]>("list_all_vocab_words").catch(() => null),
      invoke<ChatPage>("list_all_chats", {
        search: null,
        bookId: null,
        cursor: null,
        limit: 1,
      }).catch(() => null),
    ]);

    if (requestId !== bentoRequestIdRef.current) return;

    const hls = Array.isArray(hlRes) ? hlRes : [];
    const pickedHighlight = hls.find((h) => Boolean(h.text_content?.trim())) ?? hls[0] ?? null;
    setLatestHighlight(
      pickedHighlight && targetBookId ? { ...pickedHighlight, book_id: targetBookId } : null,
    );

    const words = Array.isArray(wordsRes) ? wordsRes : [];
    setWordsCount(words.length);
    setRecentWords(words.slice(0, 6));

    const chats = Array.isArray(chatsRes?.chats) ? chatsRes.chats : [];
    setLastChat(chats[0] ?? null);
  }, [totalBooksCount, books.length, nowReadingBook]);

  useEffect(() => {
    void fetchBentoDetails();
  }, [fetchBentoDetails]);

  useEffect(() => {
    const onFocus = () => {
      void fetchBentoDetails();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchBentoDetails]);

  if (booksLoading && books.length === 0) {
    return (
      <main className="flex-1 min-h-0 overflow-y-auto px-7 pt-2 pb-7 flex items-center justify-center">
        <span className="text-[14px] text-text-tertiary">{t("library.loading")}</span>
      </main>
    );
  }

  // First-launch empty library view (XkjMq + OqN9H)
  if (totalBooksCount === 0 && books.length === 0) {
    return (
      <main
        data-testid="home-empty-state"
        className="flex-1 min-h-0 overflow-y-auto px-7 -mt-2.5 pt-[18px] pb-6 flex flex-col"
      >
        <div className="w-full max-w-[1440px] m-auto flex flex-col gap-4">
          <section className="dawn-glass rounded-surface p-9 flex flex-col items-center text-center gap-[18px]">
            <QuillLogo size={68} />
            <div className="max-w-[520px] flex flex-col items-center gap-2.5">
              <h1 className="text-[30px] font-semibold tracking-[-0.8px] leading-[1.2] text-text-primary">
                {t("home.empty.headline")}
              </h1>
              <p className="text-[15px] leading-[1.55] text-text-secondary">
                {t("home.empty.subtitle")}
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
              <button
                type="button"
                onClick={onImport}
                className="h-10 px-5 rounded-control bg-accent hover:bg-accent-hover active:bg-accent-pressed text-text-on-accent text-[13.5px] font-semibold inline-flex items-center gap-2 cursor-pointer transition-colors"
              >
                <Plus size={15} strokeWidth={2.2} />
                <span>{t("home.empty.importFirst")}</span>
              </button>
              {isMac && (
                <button
                  type="button"
                  onClick={() => onOpenSettings("librarySync")}
                  className="h-10 px-5 rounded-control bg-surface-chip border border-border-default hover:bg-surface-solid text-text-primary text-[13.5px] font-medium inline-flex items-center gap-2 cursor-pointer transition-colors"
                >
                  <Cloud size={15} className="text-text-secondary" />
                  <span>{t("home.empty.turnOnICloud")}</span>
                </button>
              )}
            </div>

            <div className="px-3.5 py-1.5 rounded-full bg-surface-inset border border-border-subtle inline-flex items-center gap-2 text-[12.5px] text-text-tertiary">
              <Upload size={14} />
              <span>{t("home.empty.dropHint", { mod })}</span>
            </div>
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Highlights specimen (I4cPVe) */}
            <div className="dawn-glass rounded-surface p-[22px] flex flex-col gap-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11.5px] font-semibold uppercase tracking-[1px] text-text-tertiary">
                  {t("home.empty.specimenHighlightsEyebrow")}
                </span>
                <span className="px-[9px] py-[5px] rounded-full bg-surface-solid border border-border-subtle inline-flex items-center gap-[5px]">
                  <span className="size-[9px] rounded-full bg-hl-yellow border border-border-default" />
                  <span className="size-[9px] rounded-full bg-hl-green border border-border-default" />
                  <span className="size-[9px] rounded-full bg-hl-blue border border-border-default" />
                  <span className="size-[9px] rounded-full bg-hl-pink border border-border-default" />
                </span>
              </div>
              <div className="bg-surface-inset border border-border-subtle rounded-[6px] p-3.5 flex-1 flex items-center justify-center min-h-[210px]">
                <div className="bg-paper border border-border-subtle rounded-[6px] px-[15px] py-[13px] w-full flex flex-col gap-2.5">
                  <div className="border-l-2 border-hl-yellow pl-3 py-0.5">
                    <div className="bg-hl-yellow/60 rounded-[6px] px-2 py-[5px]">
                      <p className="font-reading text-[13px] leading-[1.45] text-text-primary">
                        {t("home.empty.specimenHighlightQuote")}
                      </p>
                    </div>
                  </div>
                  <div className="bg-surface-solid border border-border-subtle rounded-[8px] px-2.5 py-1.5 flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 min-w-0">
                      <StickyNote size={12} className="text-accent-on-tint shrink-0" />
                      <span className="text-[11.5px] font-medium text-text-secondary truncate">
                        {t("home.empty.specimenHighlightNote")}
                      </span>
                    </span>
                    <span className="font-mono text-[10.5px] text-text-tertiary shrink-0">
                      {t("home.empty.specimenHighlightPage")}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <h2 className="text-[15.5px] font-semibold tracking-[-0.25px] text-text-primary">
                  {t("home.empty.specimenHighlightsTitle")}
                </h2>
                <p className="text-[12.5px] leading-[1.45] text-text-tertiary">
                  {t("home.empty.specimenHighlightsBody")}
                </p>
              </div>
            </div>

            {/* Lexicon specimen (Gh64n) */}
            <div className="dawn-glass rounded-surface p-[22px] flex flex-col gap-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11.5px] font-semibold uppercase tracking-[1px] text-text-tertiary">
                  {t("home.empty.specimenWordsEyebrow")}
                </span>
                <span className="px-[9px] py-[3px] rounded-full bg-surface-solid border border-border-subtle inline-flex items-center gap-[5px]">
                  <Languages size={12} className="text-accent-fg" />
                  <span className="font-mono text-[10.5px] font-semibold text-text-secondary">
                    {t("lookup.title")}
                  </span>
                </span>
              </div>
              <div className="bg-surface-inset border border-border-subtle rounded-[6px] p-3.5 flex-1 flex items-center justify-center min-h-[210px]">
                <div className="bg-surface-solid border border-border-subtle rounded-[6px] px-[15px] py-[13px] w-full flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-[7px] min-w-0 flex-wrap">
                      <span className="font-reading text-[17.5px] font-bold text-text-primary">
                        {t("home.empty.specimenWord")}
                      </span>
                      <span className="font-mono text-[11px] text-text-tertiary">
                        {t("home.empty.specimenWordIpa")}
                      </span>
                      <span className="px-[7px] py-[2px] rounded-full bg-accent-tint text-accent-on-tint text-[10.5px] font-semibold">
                        {t("home.empty.specimenWordPos")}
                      </span>
                    </div>
                    <span className="px-2 py-[2px] rounded-full bg-success-tint text-success text-[10.5px] font-semibold inline-flex items-center gap-1 shrink-0">
                      <Check size={10} />
                      <span>{t("lookup.saved")}</span>
                    </span>
                  </div>
                  <p className="text-[12.5px] leading-[1.45] text-text-secondary">
                    {t("home.empty.specimenWordDef")}
                  </p>
                  <div className="pt-[7px] border-t border-border-subtle flex items-center gap-1.5">
                    <Sparkles size={12} className="text-accent-fg shrink-0" />
                    <span className="text-[11.5px] text-accent-on-tint truncate">
                      {t("home.empty.specimenWordContext")}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <h2 className="text-[15.5px] font-semibold tracking-[-0.25px] text-text-primary">
                  {t("home.empty.specimenWordsTitle")}
                </h2>
                <p className="text-[12.5px] leading-[1.45] text-text-tertiary">
                  {t("home.empty.specimenWordsBody")}
                </p>
              </div>
            </div>

            {/* Chats specimen (f6Yyeq) */}
            <div className="dawn-glass rounded-surface p-[22px] flex flex-col gap-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11.5px] font-semibold uppercase tracking-[1px] text-text-tertiary">
                  {t("home.empty.specimenChatsEyebrow")}
                </span>
                <span className="px-[9px] py-[3px] rounded-full bg-accent-tint text-accent-on-tint inline-flex items-center gap-[5px]">
                  <Sparkles size={11} />
                  <span className="text-[11px] font-semibold">
                    {t("home.empty.specimenChatsTag")}
                  </span>
                </span>
              </div>
              <div className="bg-surface-inset border border-border-subtle rounded-[6px] px-3.5 py-3 flex-1 flex flex-col justify-center gap-2 min-h-[210px]">
                <div className="border-l-2 border-accent pl-[9px] py-px">
                  <p className="font-reading text-[11.5px] text-text-tertiary truncate">
                    {t("home.empty.specimenChatQuote")}
                  </p>
                </div>
                <div className="self-end bg-accent-tint text-accent-on-tint rounded-[12px] rounded-br-[4px] px-[11px] py-1.5 max-w-[90%]">
                  <p className="text-[12px] font-medium">
                    {t("home.empty.specimenChatUser")}
                  </p>
                </div>
                <div className="bg-surface-solid border border-border-subtle rounded-[12px] rounded-tl-[4px] px-3 py-[9px] flex items-start gap-2">
                  <span className="size-5 rounded-[6px] bg-accent text-text-on-accent flex items-center justify-center shrink-0 mt-0.5">
                    <Sparkles size={11} />
                  </span>
                  <p className="text-[12px] leading-[1.4] text-text-primary">
                    {t("home.empty.specimenChatReply")}
                  </p>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <h2 className="text-[15.5px] font-semibold tracking-[-0.25px] text-text-primary">
                  {t("home.empty.specimenChatsTitle")}
                </h2>
                <p className="text-[12.5px] leading-[1.45] text-text-tertiary">
                  {t("home.empty.specimenChatsBody")}
                </p>
              </div>
            </div>
          </section>
        </div>
      </main>
    );
  }

  // Populated Bento (m2srt)
  const nowReadingPct = nowReadingBook
    ? nowReadingBook.status === "finished"
      ? 100
      : Math.max(0, Math.min(100, nowReadingBook.progress))
    : 0;
  const nowReadingTimeLeft = nowReadingBook
    ? formatReadingTimeLeft(nowReadingBook.pages, nowReadingPct, t)
    : null;
  const heroHighlight =
    nowReadingBook && latestHighlight?.book_id === nowReadingBook.id ? latestHighlight : null;
  const nowHighlightMeta = heroHighlight
    ? getHighlightColorMeta(heroHighlight.color)
    : null;
  const lastChatBook = lastChat ? booksById.get(lastChat.book_id) : undefined;
  const lastChatSource = lastChat
    ? [lastChat.book_title || lastChatBook?.title, lastChatBook?.author]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <main
      data-testid="home-bento"
      className="flex-1 min-h-0 overflow-y-auto px-7 -mt-2.5 pt-[18px] pb-6 flex flex-col"
    >
      <div className="w-full max-w-[1440px] m-auto flex flex-col gap-4">
        {/* Row 1: Now reading + Side column */}
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] xl:grid-cols-[minmax(0,1fr)_420px] gap-4">
          {nowReadingBook && (
            <section className="dawn-glass rounded-surface p-7 lg:p-8 flex flex-col sm:flex-row gap-8 lg:gap-10 min-h-[420px] lg:min-h-[448px]">
              <button
                type="button"
                onClick={() => void openReaderWindow(nowReadingBook.id)}
                className="w-[180px] sm:w-[220px] lg:w-[250px] aspect-[250/352] shrink-0 self-start text-left cursor-pointer group focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring rounded-[6px]"
              >
                <BookCover
                  title={nowReadingBook.title}
                  author={nowReadingBook.author}
                  coverData={nowReadingBook.cover_data}
                  coverPath={nowReadingBook.cover_path}
                  className="size-full transition-shadow duration-200 group-hover:shadow-[var(--shadow-cover-hover)]"
                />
              </button>

              <div className="flex-1 min-w-0 flex flex-col justify-between gap-6">
                <div className="flex flex-col gap-[22px]">
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[11.5px] font-semibold uppercase tracking-[1.2px] text-text-tertiary">
                      {nowReadingBook.status === "reading"
                        ? t("home.nowReading")
                        : nowReadingBook.status === "finished"
                          ? t("home.recentlyFinished")
                          : t("home.upNext")}
                    </span>
                    <h1 className="text-[30px] lg:text-[42px] font-semibold tracking-[-1.2px] leading-[1.15] text-text-primary line-clamp-2">
                      {nowReadingBook.title}
                    </h1>
                    <p className="text-[15px] text-text-secondary truncate">
                      {nowReadingBook.author}
                      {nowReadingBook.pages && nowReadingBook.pages > 0
                        ? ` · ${t("library.pages", { count: nowReadingBook.pages })}`
                        : ""}
                    </p>
                  </div>

                  <div className="flex flex-col gap-2.5">
                    <div className="flex items-baseline gap-3">
                      <span className="text-[36px] lg:text-[40px] font-medium tracking-[-1px] leading-none text-text-primary">
                        {nowReadingPct}%
                      </span>
                      {nowReadingTimeLeft && (
                        <span className="text-[13px] text-text-tertiary">
                          {nowReadingTimeLeft}
                        </span>
                      )}
                    </div>
                    <div className="h-1 w-full rounded-[2px] bg-track overflow-hidden">
                      <div
                        className="h-full rounded-[2px] bg-progress transition-[width] duration-200"
                        style={{ width: `${nowReadingPct}%` }}
                      />
                    </div>
                  </div>

                  {heroHighlight?.text_content && nowHighlightMeta && (
                    <div className="rounded-[6px] bg-surface-inset px-4 py-3.5 flex flex-col gap-1.5">
                      <span className="text-[12px] text-text-tertiary">
                        {t("home.lastHighlight")}
                      </span>
                      <p className="text-[15px] leading-[1.5] text-text-primary line-clamp-2">
                        <span
                          className={`${nowHighlightMeta.bgClass} px-1 py-0.5 rounded-[3px] box-decoration-clone`}
                        >
                          {heroHighlight.text_content}
                        </span>
                      </p>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => void openReaderWindow(nowReadingBook.id)}
                    className="rounded-control bg-accent hover:bg-accent-hover active:bg-accent-pressed text-text-on-accent px-5 py-3 text-[14px] font-semibold inline-flex items-center gap-2 cursor-pointer transition-colors"
                  >
                    <BookOpen size={16} />
                    <span>{t("home.continueReading")}</span>
                  </button>
                  {heroHighlight?.text_content && nowHighlightMeta && (
                    <button
                      type="button"
                      onClick={() =>
                        void openReaderWindow(nowReadingBook.id, {
                          openChat: true,
                          quote: heroHighlight.text_content ?? undefined,
                          cfi: heroHighlight.cfi_range ?? undefined,
                        })
                      }
                      className="rounded-control bg-surface-chip border border-border-default hover:bg-surface-solid text-text-primary px-5 py-3 text-[14px] font-medium inline-flex items-center gap-2 cursor-pointer transition-colors"
                    >
                      <Sparkles size={16} className="text-text-secondary" />
                      <span>{t("home.askAboutPart")}</span>
                    </button>
                  )}
                </div>
              </div>
            </section>
          )}

          <div className="flex flex-col gap-4">
            {/* Saved words card */}
            <section className="dawn-glass rounded-surface p-6 flex-1 flex flex-col gap-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium text-text-secondary">
                  {t("home.savedWords")}
                </span>
                <button
                  type="button"
                  onClick={() => onNavigate("words")}
                  aria-label={t("home.openWords")}
                  className="text-text-tertiary hover:text-text-primary cursor-pointer transition-colors"
                >
                  <ArrowUpRight size={16} />
                </button>
              </div>
              <div className="flex flex-col gap-3.5">
                <button
                  type="button"
                  onClick={() => onNavigate("words")}
                  className="text-left text-[48px] font-medium tracking-[-1.5px] leading-none text-text-primary cursor-pointer w-fit"
                >
                  {wordsCount}
                </button>
                {recentWords.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {recentWords.map((word) => (
                      <button
                        key={word.id}
                        type="button"
                        onClick={() => onNavigate("words", { wordId: word.id })}
                        title={word.word}
                        className="max-w-[calc(50%-3px)] truncate px-[11px] py-[5px] rounded-full bg-surface-chip border border-border-subtle hover:bg-surface-solid text-[13px] text-text-primary cursor-pointer transition-colors"
                      >
                        {word.word}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-[13px] text-text-tertiary">
                    {t("home.noWordsHint")}
                  </p>
                )}
              </div>
            </section>

            {/* Last conversation card */}
            <section
              role={lastChat ? "button" : undefined}
              tabIndex={lastChat ? 0 : undefined}
              onClick={(e) => {
                if (!lastChat || shouldSuppressSelectionClick(e)) return;
                onNavigate("chats", { chatId: lastChat.id });
              }}
              onKeyDown={(e) => {
                if (!lastChat) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onNavigate("chats", { chatId: lastChat.id });
                }
              }}
              className={`dawn-glass rounded-surface p-6 flex-1 flex flex-col gap-3.5 ${
                lastChat
                  ? "cursor-pointer hover:bg-surface-solid transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring"
                  : ""
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium text-text-secondary">
                  {t("home.lastConversation")}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onNavigate("chats", lastChat ? { chatId: lastChat.id } : undefined);
                  }}
                  aria-label={t("home.openChats")}
                  className="text-text-tertiary hover:text-text-primary cursor-pointer transition-colors"
                >
                  <MessageSquare size={16} />
                </button>
              </div>
              {lastChat ? (
                <div className="flex flex-col gap-2 min-w-0">
                  {lastChatSource && (
                    <span className="font-mono text-[11.5px] text-text-tertiary truncate">
                      {lastChatSource}
                    </span>
                  )}
                  <h2 className="text-[19px] font-medium tracking-[-0.3px] text-text-primary truncate">
                    {lastChat.title}
                  </h2>
                  {lastChat.last_message && (
                    <p className="text-[13.5px] leading-[1.5] text-text-tertiary line-clamp-3 select-text">
                      {lastChat.last_message}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-[13px] text-text-tertiary">
                  {t("home.noChatsHint")}
                </p>
              )}
            </section>
          </div>
        </div>

        {/* Row 2: Library 5-up shelf + Also reading / Collections */}
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] xl:grid-cols-[minmax(0,1fr)_420px] gap-4">
          <section className="dawn-glass rounded-surface p-6 lg:px-6 lg:py-5 flex flex-col gap-3.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] leading-tight font-medium text-text-secondary">
                {t("home.libraryCount", { count: totalBooksCount })}
              </span>
              <button
                type="button"
                onClick={() =>
                  onNavigate("library", { statusFilter: "all", collectionId: "all" })
                }
                aria-label={t("home.openLibrary")}
                className="text-text-tertiary hover:text-text-primary cursor-pointer transition-colors"
              >
                <ArrowUpRight size={16} />
              </button>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-3.5">
              {shelfBooks.map((book) => (
                <button
                  key={book.id}
                  type="button"
                  onClick={() => void openReaderWindow(book.id)}
                  aria-label={book.title}
                  className="text-left cursor-pointer group focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring rounded-[6px]"
                >
                  <BookCover
                    title={book.title}
                    author={book.author}
                    coverData={book.cover_data}
                    coverPath={book.cover_path}
                    className="w-full aspect-[169/238] transition-shadow duration-200 group-hover:shadow-[var(--shadow-cover-hover)]"
                  />
                </button>
              ))}
            </div>
          </section>

          <section className="dawn-glass rounded-surface p-6 lg:px-6 lg:py-5 flex flex-col justify-between gap-3">
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] leading-tight font-medium text-text-secondary">
                  {t("home.alsoReading")}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    onNavigate("library", { statusFilter: "reading", collectionId: "all" })
                  }
                  aria-label={t("home.openReading")}
                  className="text-text-tertiary hover:text-text-primary cursor-pointer transition-colors"
                >
                  <ArrowUpRight size={16} />
                </button>
              </div>

              {alsoReadingBooks.length > 0 ? (
                <div className="flex flex-col gap-3">
                  {alsoReadingBooks.map((book) => {
                    const pct = Math.max(0, Math.min(100, book.progress));
                    return (
                      <button
                        key={book.id}
                        type="button"
                        onClick={() => void openReaderWindow(book.id)}
                        className="w-full flex items-center gap-3.5 text-left rounded-[6px] p-1 -m-1 hover:bg-surface-hover cursor-pointer transition-colors"
                      >
                        <BookCover
                          title={book.title}
                          author={book.author}
                          coverData={book.cover_data}
                          coverPath={book.cover_path}
                          radius="xs"
                          shadow={false}
                          className="w-10 h-[58px] shrink-0"
                        />
                        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                          <span className="text-[14.5px] font-medium text-text-primary truncate">
                            {book.title}
                          </span>
                          <span className="text-[12px] text-text-tertiary truncate">
                            {book.author}
                          </span>
                          <div className="h-1 w-full rounded-[2px] bg-track overflow-hidden">
                            <div
                              className="h-full rounded-[2px] bg-progress"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                        <span className="font-mono text-[12px] text-text-tertiary shrink-0">
                          {pct}%
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="text-[13px] text-text-tertiary">
                  {t("home.noAlsoReading")}
                </p>
              )}
            </div>

            {collections.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="text-[13px] leading-tight font-medium text-text-secondary">
                  {t("collections.sectionTitle")}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {collections.slice(0, 4).map((col) => (
                    <Chip
                      key={col.id}
                      count={col.book_count}
                      title={col.name}
                      className="max-w-[calc(50%-3px)]"
                      onClick={() =>
                        onNavigate("library", {
                          collectionId: col.id,
                          statusFilter: "all",
                        })
                      }
                    >
                      {col.name}
                    </Chip>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
