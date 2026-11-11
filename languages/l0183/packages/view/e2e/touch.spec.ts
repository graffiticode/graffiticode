// SPDX-License-Identifier: MIT
/**
 * Touch, in a real browser, on the 40-blank fixture at phone size.
 *
 * Gestures go through CDP `Input.dispatchTouchEvent`, which feeds Chromium's own input pipeline,
 * so whether a touch scrolls or drags is decided by the browser exactly as on a phone — the thing
 * the pure `lib/gesture.ts` tests cannot check.
 */
import { expect, test, type CDPSession, type Page } from "@playwright/test";

type Pt = { x: number; y: number };

async function touch(cdp: CDPSession, type: "touchStart" | "touchMove" | "touchEnd", p?: Pt) {
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" || !p ? [] : [{ x: p.x, y: p.y }] });
}

/** Press at `from`, then move to `to` in `steps`, pausing between moves as a finger would. */
async function swipe(cdp: CDPSession, page: Page, from: Pt, to: Pt, opts: { holdMs?: number; drift?: number; steps?: number } = {}) {
  const steps = opts.steps ?? 12;
  await touch(cdp, "touchStart", from);
  if (opts.drift) {
    await page.waitForTimeout(40);
    await touch(cdp, "touchMove", { x: from.x + opts.drift, y: from.y });
  }
  if (opts.holdMs) await page.waitForTimeout(opts.holdMs);
  for (let i = 1; i <= steps; i++) {
    await touch(cdp, "touchMove", { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps });
    await page.waitForTimeout(16);
  }
  await touch(cdp, "touchEnd");
  await page.waitForTimeout(150);
}

async function centre(page: Page, selector: string): Promise<Pt> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Scroll the diagram's frame so the given blanks' centres are in the middle of it, as a learner
 * would before working on them. A 40-node web is far bigger than a phone's frame.
 */
async function reveal(page: Page, ...blanks: string[]) {
  await page.evaluate((ids) => {
    const frame = document.querySelector<HTMLElement>("[data-l0183-frame]")!;
    const fr = frame.getBoundingClientRect();
    // The part of the frame that is on screen: the square can be taller than the window.
    const top = Math.max(fr.top, 0);
    const bottom = Math.min(fr.bottom, innerHeight);
    const pts = ids.map((id) => {
      const r = document.querySelector(`[data-l0183-blank="${id}"]`)!.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    frame.scrollLeft += x - (fr.left + fr.right) / 2;
    frame.scrollTop += y - (top + bottom) / 2;
  }, blanks);
  await page.waitForTimeout(50);
}

/** The ids of empty node blanks whose centre is visible inside the diagram's frame. */
async function visibleEmptyBlanks(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const frame = document.querySelector("[data-l0183-frame]")!.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>("button[data-l0183-blank]")]
      .filter((b) => b.getAttribute("aria-label") === "Blank, empty")
      .filter((b) => {
        const r = b.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const onScreen = y > 4 && y < innerHeight - 4;
        return onScreen && x > frame.left + 4 && x < frame.right - 4 && y > frame.top + 4 && y < frame.bottom - 4;
      })
      .map((b) => b.dataset.l0183Blank!);
  });
}

/** Everything that must not move when an answer is placed. */
async function snapshot(page: Page) {
  return page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>("[data-l0183-frame]")!;
    const canvas = document.querySelector<HTMLElement>("[data-l0183-canvas]")!;
    const c = canvas.getBoundingClientRect();
    return {
      frame: [frame.clientWidth, frame.clientHeight],
      canvas: [canvas.offsetWidth, canvas.offsetHeight],
      trays: [...document.querySelectorAll<HTMLElement>("[role=group]")].map((g) => g.getBoundingClientRect().height),
      nodes: [...canvas.querySelectorAll<HTMLElement>("[data-l0183-blank]")].map((b) => {
        const r = b.getBoundingClientRect();
        return [b.dataset.l0183Blank, Math.round(r.left - c.left), Math.round(r.top - c.top)];
      }),
    };
  });
}

const answersTray = "[role=group][aria-label=Answers]";

/** Scroll the Form so the Answers tray's top sits at the bottom of the window, in view. */
async function showTray(page: Page) {
  await page.evaluate(() => {
    const form = document.querySelector<HTMLElement>(".l0183-web")!;
    const tray = document.querySelector<HTMLElement>("[role=group][aria-label=Answers]")!;
    const r = tray.getBoundingClientRect();
    form.scrollTop += r.top - (innerHeight - 120);
  });
  await page.waitForTimeout(50);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/dev.html?fixture=assessed40");
  await page.locator("[data-l0183-canvas]").waitFor();
  await page.waitForTimeout(300); // let measurement and the first relayout settle
  await page.evaluate(() => {
    (window as any).__cancels = 0;
    window.addEventListener("pointercancel", () => ((window as any).__cancels += 1), true);
  });
});

test("the phone layout keeps a usable diagram, bounded scrolling trays, and Check on screen", async ({ page }) => {
  const s = await page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>("[data-l0183-frame]")!;
    const tray = document.querySelector<HTMLElement>("[role=group][aria-label=Answers]")!;
    const check = [...document.querySelectorAll("button")].find((b) => /^check$/i.test(b.textContent!.trim()));
    return {
      frameH: frame.clientHeight,
      trayH: tray.clientHeight,
      trayScrolls: tray.scrollHeight > tray.clientHeight,
      checkBottom: check ? check.getBoundingClientRect().bottom : Infinity,
      vh: innerHeight,
    };
  });
  expect(s.frameH).toBeGreaterThanOrEqual(640 - 1);
  expect(s.trayH).toBeLessThanOrEqual(s.vh * 0.25 + 1);
  expect(s.trayScrolls).toBe(true);
  expect(s.checkBottom).toBeLessThanOrEqual(s.vh);
});

test("a small drift, a hold, then a drag from the grip places the answer and never scrolls the tray", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await showTray(page);
  // n11 is at three o'clock, mid-height, so it can sit in the frame's on-screen band.
  await reveal(page, "n11");
  const [target] = await visibleEmptyBlanks(page);
  expect(target).toBeTruthy();
  const tray = page.locator(answersTray);
  const before = await tray.evaluate((el) => el.scrollTop);
  const grip = await centre(page, `${answersTray} [data-l0183-grip]`);
  const to = await centre(page, `[data-l0183-blank="${target}"]`);
  await swipe(cdp, page, grip, to, { drift: 2, holdMs: 500 });
  await expect(page.locator(`[data-l0183-blank="${target}"]`)).toHaveAttribute("aria-label", /holding/);
  expect(await tray.evaluate((el) => el.scrollTop)).toBe(before);
  expect(await page.evaluate(() => (window as any).__cancels)).toBe(0);
});

test("an ordinary swipe on a tray item's body scrolls the tray, placing and selecting nothing", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await showTray(page);
  const tray = page.locator(answersTray);
  const body = await centre(page, `${answersTray} button`);
  await swipe(cdp, page, body, { x: body.x, y: body.y - 120 });
  expect(await tray.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.locator("[data-l0183-blank][aria-label*=holding]").count()).toBe(0);
  expect(await page.locator(`${answersTray} button[aria-pressed=true]`).count()).toBe(0);
});

test("a tap selects and a tap places; a swipe on empty canvas scrolls the frame; a filled blank drags", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await reveal(page, "n1", "n2");
  const [first, second] = await visibleEmptyBlanks(page);
  expect(first && second).toBeTruthy();

  await page.locator(`${answersTray} button`).first().tap();
  await expect(page.locator(`${answersTray} button[aria-pressed=true]`)).toHaveCount(1);
  await page.locator(`[data-l0183-blank="${first}"]`).tap();
  await expect(page.locator(`[data-l0183-blank="${first}"]`)).toHaveAttribute("aria-label", /holding/);

  // A drag from the filled blank to another moves its answer.
  const from = await centre(page, `[data-l0183-blank="${first}"]`);
  const to = await centre(page, `[data-l0183-blank="${second}"]`);
  await swipe(cdp, page, from, to);
  await expect(page.locator(`[data-l0183-blank="${second}"]`)).toHaveAttribute("aria-label", /holding/);
  await expect(page.locator(`[data-l0183-blank="${first}"]`)).toHaveAttribute("aria-label", "Blank, empty");

  // Empty canvas: a point in the frame where nothing but the canvas or its lines is hit.
  const empty = await page.evaluate(() => {
    const r = document.querySelector("[data-l0183-frame]")!.getBoundingClientRect();
    for (let y = r.top + 8; y < r.bottom - 8; y += 12)
      for (let x = r.left + 8; x < r.right - 8; x += 12) {
        const el = document.elementFromPoint(x, y);
        if (el && (el.matches("[data-l0183-canvas]") || el.closest("svg"))) return { x, y };
      }
    return null;
  });
  expect(empty).not.toBeNull();
  const frame = page.locator("[data-l0183-frame]");
  const scrollBefore = await frame.evaluate((el) => el.scrollTop + el.scrollLeft);
  await swipe(cdp, page, empty!, { x: empty!.x - 100, y: empty!.y - 100 });
  expect(await frame.evaluate((el) => el.scrollTop + el.scrollLeft)).not.toBe(scrollBefore);
});

test("placing answers, including those that empty a wrapped tray row, moves nothing", async ({ page }) => {
  const start = await snapshot(page);
  const tray = page.locator(answersTray);
  let placedCount = 0;
  for (let i = 1; i <= 8; i++) {
    await reveal(page, `n${i}`);
    const blank = `n${i}`;
    placedCount++;
    await tray.locator("button").first().tap();
    await page.locator(`[data-l0183-blank="${blank}"]`).tap();
    await page.waitForTimeout(120);
    const now = await snapshot(page);
    expect(now.frame).toEqual(start.frame);
    expect(now.canvas).toEqual(start.canvas);
    expect(now.trays).toEqual(start.trays);
    expect(now.nodes).toEqual(start.nodes);
  }
  expect(placedCount).toBe(8);
  await expect(page.locator("[data-l0183-blank][aria-label*=holding]")).toHaveCount(8);
  // And returning one to the tray.
  await reveal(page, "n1");
  await page.locator('[data-l0183-blank="n1"]').tap();
  await page.waitForTimeout(120);
  const after = await snapshot(page);
  expect(after.trays).toEqual(start.trays);
  expect(after.nodes).toEqual(start.nodes);
});

test("the diagram is a square as wide as the page, never under 640, with no upper limit", async ({ page }) => {
  for (const host of ["", "&host=learnosity"]) {
    for (const [w, h] of [
      [375, 667],
      [1280, 800],
      [2560, 1440],
      [5120, 1440],
    ]) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`/dev.html?fixture=sparse${host}`);
      await page.locator("[data-l0183-canvas]").waitFor();
      await page.waitForTimeout(300);
      const s = await page.evaluate(() => {
        const f = document.querySelector<HTMLElement>("[data-l0183-frame]")!;
        const c = document.querySelector<HTMLElement>("[data-l0183-canvas]")!;
        return { fw: f.clientWidth, fh: f.getBoundingClientRect().height, cw: c.offsetWidth, ch: c.offsetHeight };
      });
      const side = Math.max(640, s.fw);
      expect(Math.round(s.fh), `${w}x${h}${host}`).toBe(Math.round(side));
      expect([s.cw, s.ch], `${w}x${h}${host}`).toEqual([side, side]);
    }
  }
});

test("a drag held at the window's top edge scrolls the Form, so a tray below the square reaches blanks above", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await showTray(page);
  const form = page.locator(".l0183-web");
  const before = await form.evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(0);
  const grip = await centre(page, `${answersTray} [data-l0183-grip]`);
  await touch(cdp, "touchStart", grip);
  for (let i = 1; i <= 10; i++) {
    await touch(cdp, "touchMove", { x: grip.x, y: grip.y + ((10 - grip.y) * i) / 10 });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(500); // held at the edge
  const during = await form.evaluate((el) => el.scrollTop);
  await touch(cdp, "touchEnd");
  expect(during).toBeLessThan(before);
});
