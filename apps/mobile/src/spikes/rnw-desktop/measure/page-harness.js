/**
 * T4.1 spike — in-page measurement harness (THROWAWAY).
 *
 * Injected by run.cjs after the table is interactive. It drives the
 * page itself — scroll sweeps locked to rAF, trusted clicks relayed
 * through __nativeClick (installed by the driver as a real
 * page.mouse.click) — so the numbers come from the same input path a
 * user's mouse produces. Phases are published on window.__rnwPhase so
 * the driver can screenshot at the scrolled-bottom moment.
 *
 * Frame timing: a rAF sampler records inter-frame deltas. At 60Hz a
 * delta is ~16.7ms; >32ms means at least one dropped frame. All times
 * are ms from performance.now()'s time origin.
 */
/* eslint-disable */
(function () {
  'use strict';

  const ROW = 40; // desk row height px
  const STEADY_STEP = ROW; // one row per frame — the reading sweep
  const STRESS_STEP = 400; // ten rows per frame — the flick
  const SETTLE_MS = 500;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

  function makeSampler() {
    const frames = [];
    let sampling = false;
    let last = 0;
    function loop(t) {
      if (!sampling) return;
      frames.push(t - last);
      last = t;
      requestAnimationFrame(loop);
    }
    return {
      start() {
        frames.length = 0;
        sampling = true;
        last = performance.now();
        requestAnimationFrame(loop);
      },
      stop() {
        sampling = false;
        return frames.slice(1); // first delta is an artifact of last=now
      },
    };
  }

  function frameStats(frames) {
    if (frames.length === 0) return null;
    const sorted = [...frames].sort((a, b) => a - b);
    const sum = frames.reduce((a, b) => a + b, 0);
    return {
      frames: frames.length,
      avgMs: +(sum / frames.length).toFixed(2),
      medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
      p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
      maxMs: +sorted[sorted.length - 1].toFixed(2),
      dropped32: frames.filter((d) => d > 32).length,
      dropped50: frames.filter((d) => d > 50).length,
      fps: +(1000 / (sum / frames.length)).toFixed(1),
    };
  }

  function plainRect(r) {
    return r && { top: r.top, bottom: r.bottom, height: r.height };
  }

  /** ALL header elements — FlashList's sticky machinery renders a clone
   * in addition to the scrolled-away real item, so first-match lies. */
  function headerRects() {
    const r = window.__rnwspike.rects();
    const headers = [...document.querySelectorAll('[data-testid="table-header"]')].map((el) => {
      const rect = el.getBoundingClientRect();
      return { top: +rect.top.toFixed(1), height: +rect.height.toFixed(1) };
    });
    return {
      innerWidth: r.innerWidth,
      innerHeight: r.innerHeight,
      headerCount: headers.length,
      headers,
      container: plainRect(r.container),
      firstRowText: r.firstRowText,
    };
  }

  async function pressHeader(key) {
    const el = document.querySelector(`[data-testid="header-sort-${key}"]`);
    if (!el) throw new Error(`header-sort-${key} not found`);
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (typeof window.__nativeClick === 'function') {
      await window.__nativeClick(x, y);
      return 'realClick';
    }
    // fallback: synthetic pointer pair only (single press)
    const target = el.querySelector('div,span') ?? el;
    const opts = { bubbles: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 };
    target.dispatchEvent(new PointerEvent('pointerdown', opts));
    target.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
    return 'synthetic';
  }

  function waitForSortApplied(key) {
    // Measure handler-start → commit mark, both in-page: excludes the
    // driver's click-relay latency, which is BiDi/CDP noise.
    return new Promise((resolve) => {
      const startMarks = performance.getEntriesByName(`spike:sort-start:${key}`);
      const startedAt = startMarks[startMarks.length - 1].startTime;
      const t0 = performance.now();
      (function poll() {
        const marks = performance.getEntriesByName('spike:sort-applied');
        const fresh = marks.filter((m) => m.startTime >= startedAt);
        if (fresh.length > 0) {
          resolve({ appliedMs: +(fresh[fresh.length - 1].startTime - startedAt).toFixed(2), pressed: true });
          return;
        }
        if (performance.now() - t0 > 2500) {
          resolve({ appliedMs: null, pressed: false });
          return;
        }
        requestAnimationFrame(poll);
      })();
    });
  }

  async function runSpikeMeasurements() {
    if (!window.__rnwspike || !window.__rnwspike.ready) {
      return { error: 'spike hooks missing' };
    }
    const scroll = window.__rnwspike.scrollEl();
    if (!scroll) return { error: 'scroll container not found' };

    const readyMark = performance.getEntriesByName('spike:ready')[0];
    const nav = performance.getEntriesByType('navigation')[0];

    const results = {
      userAgent: navigator.userAgent,
      viewport: { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
      scroll: {
        scrollHeight: scroll.scrollHeight,
        clientHeight: scroll.clientHeight,
        rowsExpected: 500,
        rowsFit: Math.round((scroll.scrollHeight - 40) / ROW) >= 499, // minus header
      },
      mount: {
        domContentLoaded: nav ? +nav.domContentLoadedEventEnd.toFixed(0) : null,
        loadEvent: nav ? +nav.loadEventEnd.toFixed(0) : null,
        spikeReadyMs: readyMark ? +readyMark.startTime.toFixed(0) : null,
      },
      fonts: {
        plexSans: document.fonts.check('14px "Plex-Sans"'),
        plexSansMedium: document.fonts.check('500 14px "Plex-Sans-Medium"'),
        plexSansSemiBold: document.fonts.check('600 14px "Plex-Sans-SemiBold"'),
        plexCondensed: document.fonts.check('600 14px "Plex-Sans-Condensed"'),
      },
    };

    // --- sticky header at rest ---
    results.stickyAtTop = headerRects();

    // --- steady sweep: one row per frame, top to bottom ---
    scroll.scrollTop = 0;
    await nextFrame();
    let sampler = makeSampler();
    sampler.start();
    let steadyTo = 0;
    while (scroll.scrollTop < scroll.scrollHeight - scroll.clientHeight) {
      scroll.scrollTop = Math.min(scroll.scrollTop + STEADY_STEP, scroll.scrollHeight);
      steadyTo = scroll.scrollTop;
      await nextFrame();
    }
    const steadyFrames = sampler.stop();
    await sleep(SETTLE_MS);
    results.steadySweep = { stepPx: STEADY_STEP, scrolledTo: steadyTo, frames: frameStats(steadyFrames) };

    // --- stress sweep: ten rows per frame ---
    scroll.scrollTop = 0;
    await nextFrame();
    sampler = makeSampler();
    sampler.start();
    let stressTo = 0;
    while (scroll.scrollTop < scroll.scrollHeight - scroll.clientHeight) {
      scroll.scrollTop = Math.min(scroll.scrollTop + STRESS_STEP, scroll.scrollHeight);
      stressTo = scroll.scrollTop;
      await nextFrame();
    }
    const stressFrames = sampler.stop();
    await sleep(SETTLE_MS);
    results.stressSweep = { stepPx: STRESS_STEP, scrolledTo: stressTo, frames: frameStats(stressFrames) };

    // --- sticky header at the bottom of a virtualised scroll ---
    scroll.scrollTop = scroll.scrollHeight; // park at the very end
    await sleep(SETTLE_MS);
    results.stickyAtBottom = headerRects();
    results.stickyAtBottom.scrollTop = +scroll.scrollTop.toFixed(0);
    results.stickyHeld =
      results.stickyAtBottom.headers.some(
        (h) => Math.abs(h.top - results.stickyAtBottom.container.top) < 2 && h.height >= 38 && h.height <= 42,
      ) && results.stickyAtBottom.scrollTop > 0;

    window.__rnwPhase = 'at-bottom'; // driver screenshots the bottom state now
    await sleep(700);

    scroll.scrollTop = 0;
    await nextFrame();

    // --- sorts: three different columns, trusted header clicks ---
    results.sorts = [];
    for (const key of ['customer', 'amount', 'scheduledForMs', 'jobNumber']) {
      await sleep(300);
      window.__rnwspike.resetMetrics();
      const before = window.__rnwspike.rects().firstRowText;
      const sampler2 = makeSampler();
      sampler2.start();
      let pressed = 'none';
      let applied = { appliedMs: null, pressed: false };
      try {
        pressed = await pressHeader(key);
      } catch (e) {
        pressed = 'error:' + e.message;
      }
      applied = await waitForSortApplied(key);
      if (!applied.pressed) {
        // deterministic fallback: same setter, minus the input event
        window.__rnwspike.requestSort(key);
        applied = await waitForSortApplied(key);
      }
      await nextFrame();
      await sleep(SETTLE_MS);
      const frames = sampler2.stop();
      results.sorts.push({
        key,
        to: window.__rnwspike.sortState(),
        appliedMs: applied.appliedMs,
        pressed,
        orderChanged: before !== null && before !== window.__rnwspike.rects().firstRowText,
        rowsRendered: window.__rnwspike.metrics().rowsRendered,
        frames: frameStats(frames),
      });
    }

    window.__rnwPhase = 'done';
    window.__rnwResults = results;
    return results;
  }

  window.__rnwPhase = 'starting';
  window.__rnwMeasureDone = runSpikeMeasurements();
})();
