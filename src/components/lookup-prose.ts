// Shared Tailwind prose classes for the lookup surfaces (popover + vocab
// detail modal). Tight spacing tuned for the 13–14px body so bullets and
// adjacent paragraphs don't blow out the card height. Compose with a
// `text-[NNpx]` and a text color class at the call site.
export const LOOKUP_PROSE =
  "prose prose-sm max-w-none leading-[1.55] [&_p]:my-0 [&_p+p]:mt-1.5 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 [&_strong]:font-semibold [&_em]:italic [&_code]:bg-bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[12px]";
