import ExplainSelectionPopover from "./ExplainSelectionPopover";

interface LookupPopoverProps {
  x: number;
  y: number;
  word: string;
  sentence: string;
  bookTitle?: string;
  chapter?: string;
  bookId: string;
  cfi?: string;
  onSaved?: () => void;
  onQuote?: () => void;
  onClose: () => void;
}

export default function LookupPopover({
  x,
  y,
  word,
  sentence,
  bookTitle,
  chapter,
  bookId,
  cfi,
  onSaved,
  onQuote,
  onClose,
}: LookupPopoverProps) {
  return (
    <ExplainSelectionPopover
      x={x}
      y={y}
      text={word}
      sentence={sentence}
      bookTitle={bookTitle}
      chapter={chapter}
      bookId={bookId}
      cfi={cfi}
      initialMode="word"
      onSaved={onSaved}
      onQuote={onQuote}
      onClose={onClose}
    />
  );
}
