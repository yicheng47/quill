import ExplainSelectionPopover from "./ExplainSelectionPopover";

interface ExplainPopoverProps {
  x: number;
  y: number;
  text: string;
  sentence: string;
  bookTitle?: string;
  chapter?: string;
  bookId: string;
  cfi?: string;
  onSaved?: () => void;
  onQuote?: () => void;
  onClose: () => void;
}

export default function ExplainPopover({
  x,
  y,
  text,
  sentence,
  bookTitle,
  chapter,
  bookId,
  cfi,
  onSaved,
  onQuote,
  onClose,
}: ExplainPopoverProps) {
  return (
    <ExplainSelectionPopover
      x={x}
      y={y}
      text={text}
      sentence={sentence}
      bookTitle={bookTitle}
      chapter={chapter}
      bookId={bookId}
      cfi={cfi}
      initialMode="passage"
      onSaved={onSaved}
      onQuote={onQuote}
      onClose={onClose}
    />
  );
}
