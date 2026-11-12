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

/** On touch the dragged item rides this far above the finger (Web.tsx TOUCH_LIFT): to drop on a point, the finger goes this far below it. */
const TOUCH_LIFT = 44;
const lift = (p: Pt): Pt => ({ x: p.x, y: p.y + TOUCH_LIFT });

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
  // The square scales down to the page width; nothing scrolls it.
  expect(s.frameH).toBeGreaterThan(0);
  expect(s.frameH).toBeLessThanOrEqual(await page.evaluate(() => document.querySelector<HTMLElement>("[data-l0183-frame]")!.clientWidth));
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
  const to = lift(await centre(page, `[data-l0183-blank="${target}"]`));
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

test("a tap selects and a tap places; a filled blank drags; a swipe on empty canvas moves no answer", async ({ page }) => {
  // A small web: a 40-node web fitted to a phone has blanks a few pixels wide.
  await page.goto("/dev.html?fixture=cell");
  await page.locator("[data-l0183-canvas]").waitFor();
  await page.waitForTimeout(300);
  const cdp = await page.context().newCDPSession(page);
  // At phone size the frame scrolls; bring the two lower blanks into view together.
  await reveal(page, "n3", "n4");
  const [first, second] = await visibleEmptyBlanks(page);
  expect(first && second).toBeTruthy();

  await page.locator(`${answersTray} button`).first().tap();
  await expect(page.locator(`${answersTray} button[aria-pressed=true]`)).toHaveCount(1);
  await page.locator(`[data-l0183-blank="${first}"]`).tap();
  await expect(page.locator(`[data-l0183-blank="${first}"]`)).toHaveAttribute("aria-label", /holding/);

  // A drag from the filled blank to another moves its answer. (tap() scrolls its target into
  // view, which can push the other blank out of the frame; bring both back first.)
  await reveal(page, first, second);
  const from = await centre(page, `[data-l0183-blank="${first}"]`);
  const to = lift(await centre(page, `[data-l0183-blank="${second}"]`));
  await swipe(cdp, page, from, to);
  await expect(page.locator(`[data-l0183-blank="${second}"]`)).toHaveAttribute("aria-label", /holding/);
  await expect(page.locator(`[data-l0183-blank="${first}"]`)).toHaveAttribute("aria-label", "Blank, empty");

  // Empty canvas: a point in the frame where nothing but the canvas or its lines is hit. A swipe
  // there belongs to the browser: it places and lifts nothing.
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
  const holding = await page.locator("[data-l0183-blank][aria-label*=holding]").count();
  await swipe(cdp, page, empty!, { x: empty!.x - 60, y: empty!.y - 60 });
  expect(await page.locator("[data-l0183-blank][aria-label*=holding]").count()).toBe(holding);
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

test("spacing fits the room up to best fit, then the picture zooms; nothing scrolls", async ({ page }) => {
  for (const [fixture, host] of [
    ["web40", ""],
    ["web40", "&host=learnosity"],
    ["assessed40", ""],
    ["cell", ""],
    ["rain", ""],
  ]) {
    let bestW = 0;
    for (const [w, h] of [
      [5120, 2880],
      [3440, 1000],
      [1280, 800],
      [1280, 500],
      [667, 375],
      [375, 667],
      [320, 480],
    ]) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`/dev.html?fixture=${fixture}${host}`);
      await page.locator("[data-l0183-canvas]").waitFor();
      await page.waitForTimeout(300);
      const s = await page.evaluate(() => {
        const f = document.querySelector<HTMLElement>("[data-l0183-frame]")!;
        const c = document.querySelector<HTMLElement>("[data-l0183-canvas]")!;
        const form = document.querySelector<HTMLElement>(".l0183-web")!;
        const doc = document.scrollingElement!;
        const nodes = [...c.querySelectorAll<HTMLElement>(".z-10")].map((n) => n.getBoundingClientRect());
        const hit = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        const labelsOnNodes = [...c.querySelectorAll<HTMLElement>(".z-20")]
          .map((l) => (l.firstElementChild as HTMLElement).getBoundingClientRect())
          .filter((l) => nodes.some((n) => hit(l, n))).length;
        let closest = Infinity; // the smallest gap between two node boxes, on their clear axis
        for (let i = 0; i < nodes.length; i++)
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i];
            const b = nodes[j];
            const gx = Math.max(a.left, b.left) - Math.min(a.right, b.right);
            const gy = Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom);
            closest = Math.min(closest, Math.max(gx, gy));
          }
        return {
          nodeW: nodes.map((n) => Math.round(n.width)),
          zoom: Number(c.dataset.l0183Zoom),
          canvas: [c.offsetWidth, c.offsetHeight],
          frameScrolls: f.scrollWidth > f.clientWidth + 1 || f.scrollHeight > f.clientHeight + 1,
          formScrolls: form.scrollHeight > form.clientHeight + 1,
          pageScrolls: doc.scrollHeight > doc.clientHeight + 1,
          closest,
          labelsOnNodes,
        };
      });
      const at = `${fixture} ${w}x${h}${host}`;
      // Nodes keep their fixed widths, scaled only by the zoom once spacing reaches its floor.
      for (const nw of s.nodeW) expect([96, 122, 160].some((x) => Math.abs(x * s.zoom - nw) <= 1), at).toBe(true);
      // The picture fits its frame: it zooms rather than scrolls.
      expect(s.frameScrolls, at).toBe(false);
      // With the most room, the web sits at its best fit; it never spreads past it.
      if (w === 5120) bestW = s.canvas[0];
      expect(s.canvas[0], at).toBeLessThanOrEqual(bestW);
      // At best fit no label sits on a node (below it, labels slide to the clearest spot).
      if (s.canvas[0] === bestW) expect(s.labelsOnNodes, at).toBe(0);
      if (!host) {
        expect(s.formScrolls, at).toBe(false);
        expect(s.pageScrolls, at).toBe(false);
      }
    }
  }
});

test("in page flow, a drag held at the window's top edge scrolls the page, so a tray below the square reaches blanks above", async ({ page }) => {
  // Learnosity renders in its page's flow; on a short window the trays sit below the fold.
  await page.setViewportSize({ width: 375, height: 420 });
  await page.goto("/dev.html?fixture=assessed40&host=learnosity");
  await page.locator("[data-l0183-canvas]").waitFor();
  await page.waitForTimeout(300);
  const cdp = await page.context().newCDPSession(page);
  await page.locator(`${answersTray} [data-l0183-grip]`).first().evaluate((el) => el.scrollIntoView({ block: "end" }));
  await page.waitForTimeout(100);
  const before = await page.evaluate(() => scrollY);
  expect(before).toBeGreaterThan(0);
  const grip = await centre(page, `${answersTray} [data-l0183-grip]`);
  await touch(cdp, "touchStart", grip);
  for (let i = 1; i <= 10; i++) {
    await touch(cdp, "touchMove", { x: grip.x, y: grip.y + ((10 - grip.y) * i) / 10 });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(500); // held at the edge
  const during = await page.evaluate(() => scrollY);
  await touch(cdp, "touchEnd");
  expect(during).toBeLessThan(before);
});

test("the item, not the finger, targets: blue only where the item is over a blank that takes it, and a drop there lands", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/dev.html?fixture=waterCycle");
  await page.locator("[data-l0183-canvas]").waitFor();
  await page.waitForTimeout(300);
  const cdp = await page.context().newCDPSession(page);
  const grip = await centre(page, `div:has(> button:has-text("Condensation")) > [data-l0183-grip] >> visible=true`);
  const wrong = lift(await centre(page, '[data-l0183-blank="e1"]'));
  const empty = lift(await centre(page, "[data-l0183-canvas]")); // the hub: not a blank
  const right = lift(await centre(page, '[data-l0183-blank="n2"]'));
  const meaning = () => page.locator("[data-l0183-drop]").getAttribute("data-l0183-drop");
  const glide = async (from: Pt, to: Pt) => {
    for (let i = 1; i <= 8; i++) {
      await touch(cdp, "touchMove", { x: from.x + ((to.x - from.x) * i) / 8, y: from.y + ((to.y - from.y) * i) / 8 });
      await page.waitForTimeout(16);
    }
  };
  await touch(cdp, "touchStart", grip);
  await glide(grip, wrong);
  expect(await meaning()).toBe("wrong");
  await glide(wrong, empty);
  expect(await meaning()).toBe("none");
  await expect(page.locator("[data-l0183-drop]")).not.toHaveClass(/border-blue/);
  await glide(empty, right);
  expect(await meaning()).toBe("place");
  await expect(page.locator("[data-l0183-drop]")).toHaveClass(/border-blue-500/);
  await touch(cdp, "touchEnd", right);
  await expect(page.locator('[data-l0183-blank="n2"]')).toHaveAttribute("aria-label", /holding Condensation/);
});

test("with a mouse the dragged item sits on the cursor, so the cursor and the item target the same blank", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/dev.html?fixture=waterCycle");
  await page.locator("[data-l0183-canvas]").waitFor();
  await page.waitForTimeout(300);
  const src = await centre(page, 'button:has-text("Groundwater") >> visible=true');
  const right = await centre(page, '[data-l0183-blank="n6"]');
  await page.mouse.move(src.x, src.y);
  await page.mouse.down();
  await page.mouse.move(src.x + 30, src.y, { steps: 4 });
  await page.mouse.move(right.x, right.y, { steps: 12 });
  const ghost = (await page.locator("[data-l0183-drop]").boundingBox())!;
  expect(Math.abs(ghost.x + ghost.width / 2 - right.x)).toBeLessThan(2);
  expect(Math.abs(ghost.y + ghost.height / 2 - right.y)).toBeLessThan(2);
  expect(await page.locator("[data-l0183-drop]").getAttribute("data-l0183-drop")).toBe("place");
  await page.mouse.up();
  await expect(page.locator('[data-l0183-blank="n6"]')).toHaveAttribute("aria-label", /holding Groundwater/);
});

test("a drag ends on release even when the element it started from is replaced mid-drag (no zombie drag)", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/dev.html?fixture=waterCycle");
  await page.locator("[data-l0183-canvas]").waitFor();
  await page.waitForTimeout(300);
  // Fill a line-label blank with a tap-then-tap, then drag it from its text to another one.
  await page.locator('button:has-text("heats") >> visible=true').click();
  await page.locator('[data-l0183-blank="e1"]').click();
  await expect(page.locator('[data-l0183-blank="e1"]')).toHaveAttribute("aria-label", /holding heats/);
  const from = await centre(page, '[data-l0183-blank="e1"]');
  const to = await centre(page, '[data-l0183-blank="e4"]');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 30, from.y + 10, { steps: 4 });
  await expect(page.locator("[data-l0183-drop]")).toHaveCount(1);
  // A re-render replaces what was under the pointer (here, by hand: the label's face).
  await page.locator('[data-l0183-blank="e1"] > span').evaluate((el) => el.replaceWith(el.cloneNode(true)));
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
  // The drag ended: no preview stuck to the pointer, and the label moved.
  await expect(page.locator("[data-l0183-drop]")).toHaveCount(0);
  await expect(page.locator('[data-l0183-blank="e4"]')).toHaveAttribute("aria-label", /holding heats/);
  // And the next click is not swallowed: a tap on the filled blank returns its answer.
  await page.locator('[data-l0183-blank="e4"]').click();
  await expect(page.locator('[data-l0183-blank="e4"]')).not.toHaveAttribute("aria-label", /holding/);
});
