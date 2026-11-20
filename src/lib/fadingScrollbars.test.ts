// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installFadingScrollbars,
  SCROLLBAR_ACTIVE_ATTR,
  SCROLLBAR_HIDE_DELAY_MS,
} from "./fadingScrollbars";

interface MockScrollerOptions {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  clientWidth?: number;
  clientHeight?: number;
  scrollWidth?: number;
  scrollHeight?: number;
  borderLeft?: number;
  borderRight?: number;
  borderTop?: number;
  borderBottom?: number;
  overflowX?: string;
  overflowY?: string;
  direction?: "ltr" | "rtl";
  className?: string;
  tag?: "div" | "textarea";
}

function createMockScroller(opts: MockScrollerOptions = {}): HTMLElement {
  const el = document.createElement(opts.tag ?? "div");
  if (opts.className) el.className = opts.className;

  const left = opts.left ?? 0;
  const top = opts.top ?? 0;
  const borderLeft = opts.borderLeft ?? 0;
  const borderRight = opts.borderRight ?? 0;
  const borderTop = opts.borderTop ?? 0;
  const borderBottom = opts.borderBottom ?? 0;
  const width = opts.width ?? 208;
  const height = opts.height ?? 200;
  const clientWidth = opts.clientWidth ?? 200;
  const clientHeight = opts.clientHeight ?? 200;
  const scrollWidth = opts.scrollWidth ?? clientWidth;
  const scrollHeight = opts.scrollHeight ?? 600;
  const isRtl = opts.direction === "rtl";
  const vTrack = Math.max(0, width - borderLeft - borderRight - clientWidth);

  el.style.overflowX = opts.overflowX ?? "hidden";
  el.style.overflowY = opts.overflowY ?? "auto";
  if (opts.direction) el.style.direction = opts.direction;
  if (borderLeft) el.style.borderLeft = `${borderLeft}px solid transparent`;
  if (borderRight) el.style.borderRight = `${borderRight}px solid transparent`;
  if (borderTop) el.style.borderTop = `${borderTop}px solid transparent`;
  if (borderBottom) el.style.borderBottom = `${borderBottom}px solid transparent`;

  Object.defineProperties(el, {
    clientLeft: { configurable: true, value: isRtl ? borderLeft + vTrack : borderLeft },
    clientTop: { configurable: true, value: borderTop },
    clientWidth: { configurable: true, value: clientWidth },
    clientHeight: { configurable: true, value: clientHeight },
    scrollWidth: { configurable: true, value: scrollWidth },
    scrollHeight: { configurable: true, value: scrollHeight },
  });

  el.getBoundingClientRect = () =>
    ({
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;

  return el;
}

function pointerEvent(
  type: string,
  init: {
    clientX?: number;
    clientY?: number;
    button?: number;
    buttons?: number;
    relatedTarget?: EventTarget | null;
    bubbles?: boolean;
  } = {},
): MouseEvent {
  return new MouseEvent(type, {
    bubbles: init.bubbles ?? true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    button: init.button ?? 0,
    buttons: init.buttons ?? 0,
    relatedTarget: init.relatedTarget ?? null,
  });
}

describe("fadingScrollbars controller", () => {
  let teardown: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute(SCROLLBAR_ACTIVE_ATTR);
  });

  afterEach(() => {
    teardown?.();
    teardown = null;
    document.body.innerHTML = "";
    document.documentElement.removeAttribute(SCROLLBAR_ACTIVE_ATTR);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reveals on capture-phase scroll, resets timer on repeated scrolls, and fades after 1000ms", () => {
    teardown = installFadingScrollbars();
    const scroller = createMockScroller();
    document.body.appendChild(scroller);

    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);

    scroller.dispatchEvent(new Event("scroll"));
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);

    vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS - 1);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);

    // New scroll resets the 1000ms countdown.
    scroller.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS - 1);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);

    vi.advanceTimersByTime(1);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);
  });

  it("maps document and window scroll events to scrollingElement / documentElement", () => {
    teardown = installFadingScrollbars();
    const root = (document.scrollingElement ?? document.documentElement) as HTMLElement;

    document.dispatchEvent(new Event("scroll"));
    expect(root.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);

    vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS);
    expect(root.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);

    window.dispatchEvent(new Event("scroll"));
    expect(root.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);

    vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS);
    expect(root.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);
  });

  it("reveals on scrollbar-strip hover (vertical & horizontal), holds while hovered or scrolling, and supports early and late return", () => {
    teardown = installFadingScrollbars();
    const scroller = createMockScroller({
      width: 208,
      height: 208,
      clientWidth: 200,
      clientHeight: 200,
      scrollWidth: 600,
      scrollHeight: 600,
      overflowX: "auto",
      overflowY: "auto",
    });
    document.body.appendChild(scroller);

    // Content interior does not activate.
    scroller.dispatchEvent(pointerEvent("pointermove", { clientX: 100, clientY: 100 }));
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);

    // Vertical scrollbar strip activates and holds indefinitely.
    scroller.dispatchEvent(pointerEvent("pointermove", { clientX: 204, clientY: 50 }));
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);

    // Scrolling (e.g. wheeling) while hovered keeps it visible indefinitely.
    scroller.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(5000);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);

    // Moving back into content starts the 1000ms fade.
    scroller.dispatchEvent(pointerEvent("pointermove", { clientX: 100, clientY: 50 }));
    vi.advanceTimersByTime(600);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);

    // Early return cancels the pending fade.
    scroller.dispatchEvent(pointerEvent("pointermove", { clientX: 204, clientY: 50 }));
    vi.advanceTimersByTime(5000);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);

    // Moving into content and waiting >=1000ms hides the thumb.
    scroller.dispatchEvent(pointerEvent("pointermove", { clientX: 100, clientY: 50 }));
    vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);

    // Late return onto horizontal scrollbar strip reveals again.
    scroller.dispatchEvent(pointerEvent("pointermove", { clientX: 80, clientY: 204 }));
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);

    // Moving into bottom-right transparent corner (204, 204) un-hovers and fades after 1000ms.
    scroller.dispatchEvent(pointerEvent("pointermove", { clientX: 204, clientY: 204 }));
    vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);
  });

  it("respects element borders and ignores non-overflowing bordered containers", () => {
    teardown = installFadingScrollbars();
    const borderedOverflow = createMockScroller({
      left: 10,
      top: 10,
      borderLeft: 2,
      borderRight: 2,
      borderTop: 2,
      borderBottom: 2,
      width: 212, // 2 + 200 + 8 + 2
      height: 204, // 2 + 200 + 2
      clientWidth: 200,
      clientHeight: 200,
      scrollHeight: 600,
    });
    const borderedNoOverflow = createMockScroller({
      left: 300,
      top: 10,
      borderLeft: 1,
      borderRight: 1,
      borderTop: 1,
      borderBottom: 1,
      width: 202, // 1 + 200 + 1 (no scrollbar)
      height: 202,
      clientWidth: 200,
      clientHeight: 200,
      scrollHeight: 200,
    });
    document.body.append(borderedOverflow, borderedNoOverflow);

    // Hovering right border (220..222) of overflowing scroller does not activate.
    borderedOverflow.dispatchEvent(pointerEvent("pointermove", { clientX: 221, clientY: 50 }));
    expect(borderedOverflow.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);

    // Hovering inside the 8px scrollbar track (212..220) activates.
    borderedOverflow.dispatchEvent(pointerEvent("pointermove", { clientX: 216, clientY: 50 }));
    expect(borderedOverflow.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);

    // Hovering right border of a non-overflowing bordered container never activates.
    borderedNoOverflow.dispatchEvent(pointerEvent("pointermove", { clientX: 501, clientY: 50 }));
    expect(borderedNoOverflow.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);
  });

  it("isolates nested scrollers and ignores overlapping children over an ancestor scrollbar", () => {
    teardown = installFadingScrollbars();
    const outer = createMockScroller({
      left: 0,
      top: 0,
      width: 408,
      height: 400,
      clientWidth: 400,
      clientHeight: 400,
      scrollHeight: 1200,
    });
    const inner = createMockScroller({
      left: 200,
      top: 20,
      width: 208,
      height: 200,
      clientWidth: 200,
      clientHeight: 200,
      scrollHeight: 800,
    });
    const popoverChild = document.createElement("div");
    outer.append(inner, popoverChild);
    document.body.appendChild(outer);

    // Hovering inner's scrollbar strip activates ONLY inner, not outer.
    inner.dispatchEvent(pointerEvent("pointermove", { clientX: 404, clientY: 100 }));
    expect(inner.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);
    expect(outer.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);

    // Moving directly to outer's scrollbar strip fades inner and reveals outer.
    outer.dispatchEvent(pointerEvent("pointerover", { clientX: 404, clientY: 300 }));
    outer.dispatchEvent(pointerEvent("pointermove", { clientX: 404, clientY: 300 }));
    expect(outer.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);
    vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS);
    expect(inner.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);
    expect(outer.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);

    // Moving onto an overlapping popover child whose coords coincide with outer's track un-hovers outer.
    popoverChild.dispatchEvent(pointerEvent("pointerover", { clientX: 404, clientY: 300 }));
    popoverChild.dispatchEvent(pointerEvent("pointermove", { clientX: 404, clientY: 300 }));
    vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS);
    expect(outer.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);
  });

  it("keeps the thumb visible across a >1s paused mid-drag and fades 1s after release and exit", () => {
    teardown = installFadingScrollbars();
    const scroller = createMockScroller();
    document.body.appendChild(scroller);

    // Hover scrollbar, press down, drag, pause >1s, drift sideways while holding, resume, release on thumb.
    scroller.dispatchEvent(pointerEvent("pointermove", { clientX: 204, clientY: 40 }));
    scroller.dispatchEvent(pointerEvent("pointerdown", { clientX: 204, clientY: 40, button: 0, buttons: 1 }));
    scroller.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(1750);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);

    // Sideways pointer drift while holding primary button keeps thumb visible.
    scroller.dispatchEvent(pointerEvent("pointermove", { clientX: 80, clientY: 90, buttons: 1 }));
    // Releasing a secondary button mid-drag does not cancel the primary drag.
    window.dispatchEvent(pointerEvent("pointerup", { clientX: 80, clientY: 90, button: 2, buttons: 1, bubbles: false }));
    vi.advanceTimersByTime(1500);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);

    // Resume scroll and release while still on the thumb -> stays visible until pointer leaves.
    scroller.dispatchEvent(new Event("scroll"));
    scroller.dispatchEvent(pointerEvent("pointerup", { clientX: 204, clientY: 120, button: 0, buttons: 0 }));
    vi.advanceTimersByTime(2000);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);

    // Leave thumb into content -> fades after 1000ms.
    scroller.dispatchEvent(pointerEvent("pointermove", { clientX: 80, clientY: 120, buttons: 0 }));
    vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS - 1);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);
  });

  it("handles mid-drag release off the thumb and swallowed pointerup recovered on next pointermove", () => {
    teardown = installFadingScrollbars();
    const scroller = createMockScroller();
    document.body.appendChild(scroller);

    // Case 1: release off the thumb immediately schedules the 1000ms fade.
    scroller.dispatchEvent(pointerEvent("pointerdown", { clientX: 204, clientY: 40, button: 0, buttons: 1 }));
    vi.advanceTimersByTime(1500);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);

    window.dispatchEvent(pointerEvent("pointerup", { clientX: 50, clientY: 120, button: 0, buttons: 0, bubbles: false }));
    vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS - 1);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);

    // Case 2: Blink swallows pointerup/mouseup; next pointermove with buttons=0 ends drag and fades.
    scroller.dispatchEvent(pointerEvent("pointerdown", { clientX: 204, clientY: 40, button: 0, buttons: 1 }));
    vi.advanceTimersByTime(1500);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);

    scroller.dispatchEvent(pointerEvent("pointermove", { clientX: 50, clientY: 120, buttons: 0 }));
    vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);
  });

  it("ends a canceled drag on pointercancel and fades without requiring further pointer input", () => {
    teardown = installFadingScrollbars();
    const scroller = createMockScroller();
    document.body.appendChild(scroller);

    scroller.dispatchEvent(pointerEvent("pointerdown", { clientX: 204, clientY: 40, button: 0, buttons: 1 }));
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);

    // OS or touch gesture cancels the drag without firing pointerup or further moves.
    scroller.dispatchEvent(pointerEvent("pointercancel", { clientX: 204, clientY: 40, button: 0, buttons: 0 }));
    vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS - 1);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);
  });

  it("reveals a newly exposed scrollbar strip on pointerover without requiring a subsequent pointermove", () => {
    teardown = installFadingScrollbars();
    const menuScroller = createMockScroller({ left: 0, top: 0 });
    const contentChild = document.createElement("div");
    menuScroller.appendChild(contentChild);
    document.body.appendChild(menuScroller);

    // Menu opens or layout shifts the scrollbar strip under a stationary mouse -> pointerover only.
    menuScroller.dispatchEvent(pointerEvent("pointerover", { clientX: 204, clientY: 40 }));
    expect(menuScroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(menuScroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);

    // Entering child content via pointerover still clears hover and starts the 1000ms fade.
    contentChild.dispatchEvent(pointerEvent("pointerover", { clientX: 100, clientY: 40 }));
    vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS);
    expect(menuScroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);
  });

  it("fades on window blur, mouseleave, and pointerout into an iframe or outside the window", () => {
    teardown = installFadingScrollbars();
    const scroller = createMockScroller();
    document.body.appendChild(scroller);

    // pointerout with relatedTarget === null (e.g. entering book iframe or leaving window).
    scroller.dispatchEvent(pointerEvent("pointermove", { clientX: 204, clientY: 40 }));
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);
    scroller.dispatchEvent(pointerEvent("pointerout", { clientX: 210, clientY: 40, relatedTarget: null }));
    vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);

    // document mouseleave.
    scroller.dispatchEvent(pointerEvent("pointermove", { clientX: 204, clientY: 40 }));
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);
    document.dispatchEvent(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);

    // window blur clears both hover and active drag.
    scroller.dispatchEvent(pointerEvent("pointerdown", { clientX: 204, clientY: 40, button: 0, buttons: 1 }));
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);
    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS);
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);
  });

  it("excludes .scrollbar-none elements from both scroll and hover activation", () => {
    teardown = installFadingScrollbars();
    const hiddenScroller = createMockScroller({ className: "scrollbar-none" });
    document.body.appendChild(hiddenScroller);

    hiddenScroller.dispatchEvent(new Event("scroll"));
    expect(hiddenScroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);

    hiddenScroller.dispatchEvent(pointerEvent("pointermove", { clientX: 204, clientY: 40 }));
    expect(hiddenScroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);
  });

  it("supports textarea scrollbars and RTL vertical scrollbars", () => {
    teardown = installFadingScrollbars();
    const textarea = createMockScroller({
      tag: "textarea",
      overflowY: "",
      width: 208,
      height: 100,
      clientWidth: 200,
      clientHeight: 100,
      scrollHeight: 300,
    });
    const rtlScroller = createMockScroller({
      left: 300,
      top: 0,
      width: 208,
      height: 200,
      clientWidth: 200,
      clientHeight: 200,
      scrollHeight: 600,
      direction: "rtl",
    });
    document.body.append(textarea, rtlScroller);

    textarea.dispatchEvent(pointerEvent("pointermove", { clientX: 204, clientY: 50 }));
    expect(textarea.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);

    // In RTL, the 8px vertical scrollbar sits on the left edge (300..308).
    rtlScroller.dispatchEvent(pointerEvent("pointermove", { clientX: 504, clientY: 50 }));
    expect(rtlScroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);

    rtlScroller.dispatchEvent(pointerEvent("pointermove", { clientX: 304, clientY: 50 }));
    expect(rtlScroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);
  });

  it("handles detached hovered/dragged scrollers cleanly without blocking subsequent scrollers", () => {
    teardown = installFadingScrollbars();
    const popoverScroller = createMockScroller({ left: 0, top: 0 });
    const otherScroller = createMockScroller({ left: 300, top: 0 });
    document.body.append(popoverScroller, otherScroller);

    popoverScroller.dispatchEvent(pointerEvent("pointerdown", { clientX: 204, clientY: 50, button: 0, buttons: 1 }));
    expect(popoverScroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);

    // Unmount popover while mid-drag.
    popoverScroller.remove();

    // Next pointer move over another scroller still works normally and cleans up detached state.
    otherScroller.dispatchEvent(pointerEvent("pointermove", { clientX: 504, clientY: 50 }));
    expect(popoverScroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);
    expect(otherScroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);
  });

  it("cleans up listeners, pending timers, and active attributes on teardown", () => {
    const stop = installFadingScrollbars();
    teardown = null;
    const scroller = createMockScroller();
    document.body.appendChild(scroller);

    scroller.dispatchEvent(new Event("scroll"));
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(true);

    stop();
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);

    // Listeners are detached after teardown.
    scroller.dispatchEvent(new Event("scroll"));
    scroller.dispatchEvent(pointerEvent("pointermove", { clientX: 204, clientY: 50 }));
    expect(scroller.hasAttribute(SCROLLBAR_ACTIVE_ATTR)).toBe(false);
  });
});
