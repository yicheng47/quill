// Shared Tailwind prose classes for the lookup surfaces (popover + vocab
// detail modal). Tight spacing tuned for the 13–14px body so bullets and
// adjacent paragraphs don't blow out the card height. Compose with a
// `text-[NNpx]` and a text color class at the call site.
export const LOOKUP_PROSE =
  "prose prose-sm max-w-none leading-[1.55] [&_p]:my-0 [&_p+p]:mt-1.5 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 [&_strong]:font-semibold [&_em]:italic [&_code]:bg-border-subtle [&_code]:font-mono [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[12px]";

// Theme-normalized classes for sanitized HTML rendered from imported StarDict
// or MDict dictionaries so entries inherit Quill's Dawn and Ember palette.
export const DICT_HTML_PROSE =
  "leading-[1.55] text-text-primary [&_p]:my-0 [&_p+p]:mt-1.5 [&_div+div]:mt-1 [&_b]:font-semibold [&_strong]:font-semibold [&_i]:italic [&_em]:italic [&_ul]:my-1 [&_ul]:pl-4 [&_ul]:list-disc [&_ol]:my-1 [&_ol]:pl-4 [&_ol]:list-decimal [&_li+li]:mt-0.5 [&_dt]:font-semibold [&_dd]:ml-3 [&_dd]:text-text-secondary [&_blockquote]:border-l-2 [&_blockquote]:border-border-default [&_blockquote]:pl-2.5 [&_blockquote]:my-1.5 [&_blockquote]:text-text-secondary [&_hr]:my-2 [&_hr]:border-border-subtle";
