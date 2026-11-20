export const SCROLLBAR_ACTIVE_ATTR = "data-scrollbar-active";
export const SCROLLBAR_HIDE_DELAY_MS = 1000;

const MIN_SCROLLBAR_TRACK_PX = 2;

function isHtmlElement(node: unknown, win: Window): node is HTMLElement {
  if (!node || typeof node !== "object") return false;
  const ctor = (win as unknown as { HTMLElement?: typeof HTMLElement }).HTMLElement ?? HTMLElement;
  return node instanceof ctor;
}

function isWindowTarget(target: EventTarget | null, win: Window, doc: Document): boolean {
  return (
    target === win ||
    (target !== null &&
      typeof target === "object" &&
      "document" in target &&
      (target as { document?: unknown }).document === doc)
  );
}

function isOverflowScrollable(overflow: string, isRoot: boolean, isTextarea: boolean): boolean {
  if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") {
    return true;
  }
  if (isRoot || isTextarea) {
    return overflow !== "hidden" && overflow !== "clip";
  }
  return false;
}

function getRootScroller(doc: Document, win: Window): HTMLElement | null {
  const root = doc.scrollingElement ?? doc.documentElement;
  return isHtmlElement(root, win) ? root : null;
}

export function isPointInScrollbarStrip(
  el: HTMLElement,
  clientX: number,
  clientY: number,
  win: Window = window,
  doc: Document = document,
): boolean {
  if (!el.isConnected || el.classList.contains("scrollbar-none")) {
    return false;
  }

  const rootScroller = getRootScroller(doc, win);
  if (el === rootScroller && el === doc.documentElement) {
    const style = win.getComputedStyle(el);
    const isRtl = style.direction === "rtl";
    const vTrackWidth = win.innerWidth - el.clientWidth;
    const hTrackHeight = win.innerHeight - el.clientHeight;
    const hasVBar =
      el.scrollHeight > el.clientHeight &&
      isOverflowScrollable(style.overflowY, true, false) &&
      vTrackWidth >= MIN_SCROLLBAR_TRACK_PX;
    const hasHBar =
      el.scrollWidth > el.clientWidth &&
      isOverflowScrollable(style.overflowX, true, false) &&
      hTrackHeight >= MIN_SCROLLBAR_TRACK_PX;

    if (!hasVBar && !hasHBar) return false;

    const inV =
      hasVBar &&
      clientY >= 0 &&
      (hasHBar ? clientY < el.clientHeight : clientY <= win.innerHeight) &&
      (isRtl
        ? clientX >= 0 && clientX <= vTrackWidth
        : clientX >= el.clientWidth && clientX <= win.innerWidth);

    const inH =
      hasHBar &&
      clientY >= el.clientHeight &&
      clientY <= win.innerHeight &&
      (hasVBar
        ? isRtl
          ? clientX > vTrackWidth && clientX <= win.innerWidth
          : clientX >= 0 && clientX < el.clientWidth
        : clientX >= 0 && clientX <= win.innerWidth);

    return inV || inH;
  }

  const maybeY = el.scrollHeight > el.clientHeight;
  const maybeX = el.scrollWidth > el.clientWidth;
  if (!maybeY && !maybeX) return false;

  const rect = el.getBoundingClientRect();
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    clientX < rect.left ||
    clientX > rect.right ||
    clientY < rect.top ||
    clientY > rect.bottom
  ) {
    return false;
  }

  const style = win.getComputedStyle(el);
  const isTextarea = el.tagName === "TEXTAREA";
  const canScrollY = maybeY && isOverflowScrollable(style.overflowY, false, isTextarea);
  const canScrollX = maybeX && isOverflowScrollable(style.overflowX, false, isTextarea);
  if (!canScrollY && !canScrollX) return false;

  const borderLeft = parseFloat(style.borderLeftWidth) || 0;
  const borderRight = parseFloat(style.borderRightWidth) || 0;
  const borderTop = parseFloat(style.borderTopWidth) || 0;
  const borderBottom = parseFloat(style.borderBottomWidth) || 0;

  const innerLeft = rect.left + borderLeft;
  const innerRight = rect.right - borderRight;
  const innerTop = rect.top + borderTop;
  const innerBottom = rect.bottom - borderBottom;

  if (clientX < innerLeft || clientX > innerRight || clientY < innerTop || clientY > innerBottom) {
    return false;
  }

  const isRtl = style.direction === "rtl";
  const vStart = isRtl ? innerLeft : rect.left + el.clientLeft + el.clientWidth;
  const vEnd = isRtl ? rect.left + el.clientLeft : innerRight;
  const vTrackWidth = vEnd - vStart;

  const hStart = rect.top + el.clientTop + el.clientHeight;
  const hEnd = innerBottom;
  const hTrackHeight = hEnd - hStart;

  const hasVBar = canScrollY && vTrackWidth >= MIN_SCROLLBAR_TRACK_PX;
  const hasHBar = canScrollX && hTrackHeight >= MIN_SCROLLBAR_TRACK_PX;
  if (!hasVBar && !hasHBar) return false;

  const inV =
    hasVBar &&
    clientX >= vStart &&
    clientX <= vEnd &&
    clientY >= innerTop &&
    (hasHBar ? clientY < hStart : clientY <= innerBottom);

  const inH =
    hasHBar &&
    clientY >= hStart &&
    clientY <= hEnd &&
    (hasVBar
      ? isRtl
        ? clientX > vEnd && clientX <= innerRight
        : clientX >= innerLeft && clientX < vStart
      : clientX >= innerLeft && clientX <= innerRight);

  return inV || inH;
}

export function installFadingScrollbars(
  win: Window = window,
  doc: Document = document,
): () => void {
  const timers = new WeakMap<HTMLElement, number>();
  const activeElements = new Set<HTMLElement>();
  let hoveredEl: HTMLElement | null = null;
  let draggedEl: HTMLElement | null = null;

  const isPinned = (el: HTMLElement): boolean => el === hoveredEl || el === draggedEl;

  const clearTimer = (el: HTMLElement) => {
    const timer = timers.get(el);
    if (timer !== undefined) {
      win.clearTimeout(timer);
      timers.delete(el);
    }
  };

  const cleanupElement = (el: HTMLElement) => {
    clearTimer(el);
    el.removeAttribute(SCROLLBAR_ACTIVE_ATTR);
    activeElements.delete(el);
  };

  const pruneDetached = () => {
    if (hoveredEl && !hoveredEl.isConnected) {
      const detached = hoveredEl;
      hoveredEl = null;
      if (draggedEl === detached) draggedEl = null;
      cleanupElement(detached);
    }
    if (draggedEl && !draggedEl.isConnected) {
      const detached = draggedEl;
      draggedEl = null;
      cleanupElement(detached);
    }
  };

  const show = (el: HTMLElement) => {
    clearTimer(el);
    el.setAttribute(SCROLLBAR_ACTIVE_ATTR, "");
    activeElements.add(el);
  };

  const scheduleHide = (el: HTMLElement) => {
    clearTimer(el);
    activeElements.add(el);
    const timer = win.setTimeout(() => {
      timers.delete(el);
      if (isPinned(el)) return;
      el.removeAttribute(SCROLLBAR_ACTIVE_ATTR);
      activeElements.delete(el);
    }, SCROLLBAR_HIDE_DELAY_MS);
    timers.set(el, timer);
  };

  const clearHover = () => {
    const el = hoveredEl;
    if (!el) return;
    hoveredEl = null;
    if (!isPinned(el)) {
      scheduleHide(el);
    }
  };

  const setHover = (el: HTMLElement) => {
    if (hoveredEl === el) {
      show(el);
      return;
    }
    if (hoveredEl) {
      clearHover();
    }
    hoveredEl = el;
    show(el);
  };

  const cancelInteraction = () => {
    const dragged = draggedEl;
    const hovered = hoveredEl;
    draggedEl = null;
    hoveredEl = null;
    if (dragged) {
      scheduleHide(dragged);
    }
    if (hovered && hovered !== dragged) {
      scheduleHide(hovered);
    }
  };

  const resolveScrollTarget = (target: EventTarget | null): HTMLElement | null => {
    if (target === doc || isWindowTarget(target, win, doc)) {
      return getRootScroller(doc, win);
    }
    return isHtmlElement(target, win) ? target : null;
  };

  const findHoveredScrollbar = (
    target: EventTarget | null,
    clientX: number,
    clientY: number,
  ): HTMLElement | null => {
    if (target === doc || isWindowTarget(target, win, doc)) {
      const root = getRootScroller(doc, win);
      return root && isPointInScrollbarStrip(root, clientX, clientY, win, doc) ? root : null;
    }

    let candidate: HTMLElement | null = null;
    if (isHtmlElement(target, win)) {
      candidate = target;
    } else if (
      target &&
      typeof target === "object" &&
      "parentElement" in target &&
      isHtmlElement((target as Node).parentElement, win)
    ) {
      candidate = (target as Node).parentElement;
    }

    if (!candidate) return null;
    if (isPointInScrollbarStrip(candidate, clientX, clientY, win, doc)) {
      return candidate;
    }
    if (candidate === doc.body) {
      const root = getRootScroller(doc, win);
      if (root && root !== candidate && isPointInScrollbarStrip(root, clientX, clientY, win, doc)) {
        return root;
      }
    }
    return null;
  };

  const updateHoverFromPointer = (
    target: EventTarget | null,
    clientX: number,
    clientY: number,
  ) => {
    const hit = findHoveredScrollbar(target, clientX, clientY);
    if (hit === hoveredEl) return;
    if (hit) {
      setHover(hit);
    } else if (hoveredEl) {
      clearHover();
    }
  };

  const endDrag = (target: EventTarget | null, clientX: number, clientY: number) => {
    const el = draggedEl;
    if (!el) return;
    draggedEl = null;

    const hit = findHoveredScrollbar(target, clientX, clientY);
    const stillOverDragged =
      hit === el ||
      ((target === doc || isWindowTarget(target, win, doc) || target === null) &&
        el.isConnected &&
        isPointInScrollbarStrip(el, clientX, clientY, win, doc));

    if (stillOverDragged) {
      if (hoveredEl && hoveredEl !== el) {
        clearHover();
      }
      hoveredEl = el;
      show(el);
      return;
    }

    if (hoveredEl === el) {
      hoveredEl = null;
    }
    scheduleHide(el);
    if (hit) {
      setHover(hit);
    }
  };

  const onScroll = (e: Event) => {
    pruneDetached();
    const el = resolveScrollTarget(e.target);
    if (!el || el.classList.contains("scrollbar-none")) return;
    show(el);
    if (!isPinned(el)) {
      scheduleHide(el);
    }
  };

  const onPointerMove = (e: MouseEvent) => {
    pruneDetached();
    if (draggedEl) {
      // Blink's native scrollbar drag can swallow pointerup/mouseup; once
      // pointermove resumes with primary button released, finalize the drag.
      if ((e.buttons & 1) === 0) {
        endDrag(e.target, e.clientX, e.clientY);
        return;
      }
      show(draggedEl);
      return;
    }

    updateHoverFromPointer(e.target, e.clientX, e.clientY);
  };

  const onPointerDown = (e: MouseEvent) => {
    pruneDetached();
    if (e.button !== 0) return;

    const hit = findHoveredScrollbar(e.target, e.clientX, e.clientY);
    if (!hit) {
      if (draggedEl) {
        endDrag(e.target, e.clientX, e.clientY);
      }
      return;
    }

    const prevDragged = draggedEl;
    const prevHovered = hoveredEl;
    draggedEl = hit;
    hoveredEl = hit;
    if (prevDragged && prevDragged !== hit) {
      scheduleHide(prevDragged);
    }
    if (prevHovered && prevHovered !== hit && prevHovered !== prevDragged) {
      scheduleHide(prevHovered);
    }
    show(hit);
  };

  const onPointerUp = (e: MouseEvent) => {
    pruneDetached();
    if (!draggedEl || e.button !== 0) return;
    endDrag(e.target, e.clientX, e.clientY);
  };

  const onPointerCancel = () => {
    pruneDetached();
    cancelInteraction();
  };

  const onPointerOver = (e: MouseEvent) => {
    pruneDetached();
    if (draggedEl || (e.buttons & 1) !== 0) return;
    updateHoverFromPointer(e.target, e.clientX, e.clientY);
  };

  const onPointerOut = (e: MouseEvent) => {
    pruneDetached();
    if (draggedEl || !hoveredEl || (e.buttons & 1) !== 0) return;
    if (e.relatedTarget === null) {
      clearHover();
    }
  };

  const onMouseLeave = (e: MouseEvent) => {
    pruneDetached();
    if (draggedEl || !hoveredEl || (e.buttons & 1) !== 0) return;
    clearHover();
  };

  const onBlur = () => {
    pruneDetached();
    cancelInteraction();
  };

  const docEl = doc.documentElement;
  win.addEventListener("scroll", onScroll, { capture: true, passive: true });
  doc.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
  doc.addEventListener("pointerover", onPointerOver, { capture: true, passive: true });
  doc.addEventListener("pointerout", onPointerOut, { capture: true, passive: true });
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("mousedown", onPointerDown, true);
  win.addEventListener("pointerup", onPointerUp, true);
  win.addEventListener("mouseup", onPointerUp, true);
  win.addEventListener("pointercancel", onPointerCancel, true);
  doc.addEventListener("mouseleave", onMouseLeave);
  docEl?.addEventListener("pointerleave", onMouseLeave);
  win.addEventListener("blur", onBlur);

  return () => {
    win.removeEventListener("scroll", onScroll, true);
    doc.removeEventListener("pointermove", onPointerMove, true);
    doc.removeEventListener("pointerover", onPointerOver, true);
    doc.removeEventListener("pointerout", onPointerOut, true);
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("mousedown", onPointerDown, true);
    win.removeEventListener("pointerup", onPointerUp, true);
    win.removeEventListener("mouseup", onPointerUp, true);
    win.removeEventListener("pointercancel", onPointerCancel, true);
    doc.removeEventListener("mouseleave", onMouseLeave);
    docEl?.removeEventListener("pointerleave", onMouseLeave);
    win.removeEventListener("blur", onBlur);

    for (const el of activeElements) {
      cleanupElement(el);
    }
    activeElements.clear();
    hoveredEl = null;
    draggedEl = null;
  };
}
