interface SelectionSnapshot {
  anchorNode: Node | null;
  anchorOffset: number;
  focusNode: Node | null;
  focusOffset: number;
  isCollapsed: boolean;
  text: string;
}

let pointerDownSnapshot: SelectionSnapshot | null = null;
let selectionChangedDuringPointer = false;
let trackerAttached = false;

function captureSelectionSnapshot(): SelectionSnapshot | null {
  if (typeof window === "undefined") return null;
  const selection = window.getSelection();
  if (!selection) return null;
  return {
    anchorNode: selection.anchorNode,
    anchorOffset: selection.anchorOffset,
    focusNode: selection.focusNode,
    focusOffset: selection.focusOffset,
    isCollapsed: selection.isCollapsed,
    text: selection.toString(),
  };
}

function snapshotsMatch(a: SelectionSnapshot | null, b: SelectionSnapshot | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.anchorNode === b.anchorNode &&
    a.anchorOffset === b.anchorOffset &&
    a.focusNode === b.focusNode &&
    a.focusOffset === b.focusOffset &&
    a.isCollapsed === b.isCollapsed &&
    a.text === b.text
  );
}

function handlePointerDownCapture(): void {
  pointerDownSnapshot = captureSelectionSnapshot();
  selectionChangedDuringPointer = false;
}

function handleSelectionChangeCapture(): void {
  if (pointerDownSnapshot !== null) {
    selectionChangedDuringPointer = true;
  }
}

export function ensureSelectionTracker(): void {
  if (trackerAttached || typeof document === "undefined") return;
  trackerAttached = true;
  document.addEventListener("pointerdown", handlePointerDownCapture, true);
  document.addEventListener("mousedown", handlePointerDownCapture, true);
  document.addEventListener("selectionchange", handleSelectionChangeCapture, true);
}

ensureSelectionTracker();

/** Return whether the active non-empty text selection began inside `container`. */
export function hasSelectionInside(container: Node | null): boolean {
  if (!container) return false;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.toString().length === 0) {
    return false;
  }
  return Boolean(selection.anchorNode && container.contains(selection.anchorNode));
}

/**
 * Return whether a pointer click (`detail > 0`) should be ignored because this
 * pointer gesture created or changed a non-empty text selection anchored inside
 * `currentTarget`. Keyboard/AT activations (`detail === 0`) and ordinary clicks
 * made while an earlier selection remains unchanged still run.
 */
export function shouldSuppressSelectionClick(event: {
  detail: number;
  currentTarget: Node | null;
}): boolean {
  ensureSelectionTracker();
  if (event.detail <= 0) return false;
  if (!hasSelectionInside(event.currentTarget)) return false;
  const currentSnapshot = captureSelectionSnapshot();
  return selectionChangedDuringPointer || !snapshotsMatch(pointerDownSnapshot, currentSnapshot);
}
