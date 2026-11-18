declare module "*public/foliate-js/epubcfi.js" {
  export const isCFI: RegExp;
  export function parse(cfi: string): unknown;
  export function collapse(cfi: unknown, toEnd?: boolean): unknown;
  export function compare(a: string, b: string): number;
}
