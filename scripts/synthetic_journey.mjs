#!/usr/bin/env node
/**
 * Synthetic end-to-end check of the public demo — the detector half of the
 * watchdog loop (see .github/workflows/demo-watchdog.yml).
 *
 * WHY A REAL BROWSER, AND WHY THE REAL JOURNEY
 *
 * `keep-demo-warm.yml` already curls /health every 10 minutes, and on
 * 2026-08-04 it reported healthy throughout an outage that made the demo
 * completely unusable. It could not have caught it: curl is not a browser,
 * so it does not evaluate Content-Security-Policy, does not send an Origin
 * header, and does not enforce CORS. The failure lived entirely in those
 * layers. Everything a component check can see was fine.
 *
 * So this drives an actual Chromium instance through the actual first
 * thing a visitor does — load /bede/, click "Generate my code" — and
 * reports what a visitor would experience. It is the only check in this
 * repo that can fail for the reason a user would.
 *
 * WHAT MAKES IT MACHINE-ACTIONABLE
 *
 * It reads back the always-on diagnostics buffer (demo/src/diagnostics.ts)
 * via __bedeDebugEntries() and includes it in the report. That buffer is
 * what turns "it didn't work" into "connect-src blocked this exact URI",
 * which is the difference between a human having to investigate and an
 * agent being able to act. This script is the reason those diagnostics are
 * worth collecting at all in an unattended setting.
 *
 * SOFT DEPENDENCY: the diagnostics buffer it reads back is added by a
 * separate change (demo/src/diagnostics.ts). Without it the read simply
 * returns [] and every other signal here — CSP violations, failed
 * requests, response statuses, what the visitor saw — still works. The
 * buffer makes the report far more actionable; it is not required for it
 * to be useful.
 *
 * OUTPUT is JSON on stdout — one object, always, pass or fail — so the
 * workflow can hand it to an agent verbatim without scraping logs.
 *
 * PRIVACY: this is a synthetic session. The "student" is a fixed fake name
 * on a throwaway demo code, and nothing about a real family is read,
 * transmitted, or stored. The diagnostics it captures are its own.
 *
 * Usage:  node scripts/synthetic_journey.mjs https://agnusdei.ai/bede/
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const TARGET = process.argv[2] || process.env.DEMO_URL || 'https://agnusdei.ai/bede/';
const TIMEOUT_MS = Number(process.env.JOURNEY_TIMEOUT_MS || 90_000);
// Bounded separately from TIMEOUT_MS: picture study is a secondary signal
// and must never be able to hold the whole journey open.
const PICTURE_PROBE_TIMEOUT_MS = Number(process.env.PICTURE_PROBE_TIMEOUT_MS || 20_000);

/**
 * The picture-study probe's subject, read from the real catalog rather than
 * hardcoded, so it cannot drift from what the app actually ships.
 *
 * ONE entry, deterministically the first picture_study one, not all 23 —
 * the failures this guards against (a CSP that forbids the origins, a
 * changed Wikimedia API shape, a changed image host) are systemic and show
 * up on any entry. Validating every title is catalog hygiene, belongs in a
 * test rather than a check that runs every 30 minutes, and would multiply
 * both the runtime and the flakiness surface of a watchdog whose whole
 * value is that it only cries wolf for real.
 */
function pickProbeAid() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const catalog = JSON.parse(
      readFileSync(join(here, '..', 'homeschool-api', 'data', 'visual_aids.json'), 'utf8')
    );
    const aids = catalog.visual_aids || [];
    const wanted = process.env.PICTURE_PROBE_AID_ID;
    return (
      (wanted && aids.find((a) => a.id === wanted)) ||
      aids.find((a) => a.category === 'picture_study') ||
      aids[0] ||
      null
    );
  } catch {
    // Running outside a repo checkout is a legitimate way to use this
    // script against a deployed demo. Skipping the probe is the right
    // outcome; failing the journey over it is not.
    return null;
  }
}

/**
 * Device profiles, because "it works" is a claim about a device, not about
 * a site. Bede is used on whatever hardware a family already owns, which
 * skews cheap and small — a Galaxy A10 (360×760, 2GB RAM, Android 9) is a
 * realistic school device in a way a developer's laptop is not, and it is
 * the profile most likely to expose a layout that hides the button or a
 * touch target too small to hit.
 *
 * Emulation is not the same as the real handset — it matches viewport,
 * user agent, DPR, touch and mobile flags, but not the renderer, not the
 * memory ceiling, and not Android WebView quirks. It catches layout and
 * input-model failures, which is most of them. It does not let anyone
 * claim the app was tested on an A10. Say "emulated" when reporting.
 */
const PROFILES = {
  desktop: { name: 'desktop', ctx: {} },
  'galaxy-a10': {
    name: 'galaxy-a10 (emulated)',
    ctx: {
      viewport: { width: 360, height: 760 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (Linux; Android 10; SM-A105F) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    },
  },
  'android-tablet': {
    name: 'android-tablet (emulated)',
    ctx: {
      viewport: { width: 800, height: 1280 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  },
  ipad: { name: 'ipad (emulated)', ctx: devices['iPad (gen 7)'] },
};

const PROFILE = PROFILES[process.env.DEVICE_PROFILE || 'desktop'] || PROFILES.desktop;

/** Everything the run observed. Emitted whole, pass or fail. */
const report = {
  target: TARGET,
  device: PROFILE.name,
  startedAt: new Date().toISOString(),
  ok: false,
  failedStep: null,
  summary: '',
  cspViolations: [],
  consoleErrors: [],
  networkFailures: [],
  requests: [],
  diagnosticsBuffer: [],
  pictureStudy: null,
  entryPage: null,
};

function finish(code) {
  report.finishedAt = new Date().toISOString();
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(code);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
const context = await browser.newContext(PROFILE.ctx);
const page = await context.newPage();

// A precise, structured record of every CSP refusal, alongside the console
// scrape below. The console text says a policy fired; this says WHICH
// directive refused WHICH URI, which is the difference between "picture
// study is broken" and "picture study is broken because img-src forbids
// the image host". Installed via addInitScript so it is listening before
// the app's own first line runs.
await page.addInitScript(() => {
  window.__bedeCspViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__bedeCspViolations.push({
      directive: e.violatedDirective,
      blockedURI: e.blockedURI,
    });
  });
});

/**
 * Does picture study actually work for a visitor?
 *
 * NOT by driving Bede until it decides to call show_visual_aid. That would
 * make this check depend on a model's choice — non-deterministic, several
 * paid LLM turns per run, every 30 minutes — and a watchdog that fails for
 * reasons other than a real outage gets muted, which is worse than not
 * having one.
 *
 * The failure this exists for had nothing to do with the model. Every
 * picture-study card on the demo rendered "Picture unavailable right now"
 * for a straightforwardly deterministic reason: the CSP forbade both
 * origins VisualAidCard.tsx needs. So this performs exactly what that
 * component performs — the same lookup, then the image that lookup returns
 * — inside the real page, and is therefore governed by the real deployed
 * policy. That last part is the point: a repository whose site/_headers is
 * correct can still be serving a stale or overridden header, and only a
 * request made from the deployed origin can tell.
 */
async function probePictureStudy(aid) {
  return page.evaluate(
    async ({ title, timeoutMs }) => {
      const seen = window.__bedeCspViolations?.length ?? 0;
      const out = { wikiTitle: title, lookupOk: false, imageOk: false };
      let data = null;
      try {
        const res = await fetch(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
        );
        out.lookupStatus = res.status;
        if (res.ok) {
          data = await res.json();
          out.lookupOk = true;
        }
      } catch (err) {
        out.lookupError = String(err);
      }

      // The same two fields VisualAidCard.tsx reads, in the same order.
      const src = data?.thumbnail?.source || data?.originalimage?.source || null;
      out.imageUrl = src;
      if (src) {
        try {
          out.imageHost = new URL(src).host;
        } catch {
          out.imageHost = null;
        }
        out.imageOk = await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(true);
          img.onerror = () => resolve(false);
          img.src = src;
          setTimeout(() => resolve(false), timeoutMs);
        });
      }

      // A violation event is dispatched asynchronously after the refusal.
      await new Promise((r) => setTimeout(r, 300));
      out.violations = (window.__bedeCspViolations || []).slice(seen);
      return out;
    },
    { title: aid.wiki_title, timeoutMs: Math.min(PICTURE_PROBE_TIMEOUT_MS, 15_000) }
  );
}

// A CSP block is the one failure with no server-side trace at all, so it is
// captured first-class rather than inferred from a generic console error.
page.on('console', (m) => {
  if (m.type() !== 'error' && m.type() !== 'warning') return;
  const text = m.text();
  if (/Content Security Policy|Refused to connect/i.test(text)) {
    report.cspViolations.push(text);
  } else if (m.type() === 'error') {
    report.consoleErrors.push(text);
  }
});
page.on('requestfailed', (r) => {
  report.networkFailures.push({
    url: new URL(r.url()).origin + new URL(r.url()).pathname, // no query string — see privacy note
    method: r.method(),
    failure: r.failure()?.errorText ?? 'unknown',
  });
});
page.on('response', (r) => {
  const u = new URL(r.url());
  // Only the app's own API calls; page assets are noise here.
  if (/\/auth\/|\/tutor\/|\/feedback|\/health/.test(u.pathname)) {
    report.requests.push({ url: u.origin + u.pathname, status: r.status() });
  }
});

try {
  // ── Step 1: the page loads at all ────────────────────────────────────
  const res = await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  if (!res || !res.ok()) {
    report.failedStep = 'load';
    report.summary = `The demo page did not load (HTTP ${res ? res.status() : 'no response'}).`;
    finish(1);
  }

  // ── Step 1b: the consent gate ────────────────────────────────────────
  // The demo shows ConsentModal before anything else (see
  // demo/src/useConsent.ts), and it is a full-screen overlay that
  // intercepts pointer events — so the button below is visible and
  // clickable-looking but not actually reachable. Found by running this
  // check rather than reasoning about it: the first version went straight
  // for the button and timed out against an overlay it never mentioned.
  //
  // Dismissed by clicking it rather than by pre-seeding localStorage,
  // deliberately: consent is part of the real journey, and a check that
  // skips it would stop noticing if that screen ever broke.
  // Wait for client hydration rather than racing the initial HTML and React mount.
  // The control is translated, so cover both supported login languages.
  const consent = page.getByRole('button', { name: /I understand and agree|Entiendo y acepto/i }).first();
  if (await consent.isVisible().catch(() => false)) {
    await consent.click();
    await consent.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
  }

  // ── Step 2: the visitor's first and only action ──────────────────────
  // Matched by role/text rather than a CSS class so a styling change does
  // not produce a false alarm — this check must fail for real reasons only,
  // or it will be ignored, which is worse than not having it.
  const button = page.getByRole('button', { name: /generate my code|generar mi código/i }).first();
  await button.waitFor({ state: 'visible', timeout: 30_000 }).catch(async () => {
    report.failedStep = 'find-button';
    // A 200 from the hosting platform is not evidence that the expected demo
    // app loaded. Record real page identity to distinguish stale/deployed wrong
    // content from a JavaScript mounting failure.
    report.entryPage = await page.evaluate(() => ({
      title: document.title.slice(0, 200),
      url: location.href,
      headings: [...document.querySelectorAll('h1,h2')].slice(0, 6).map(el => (el.textContent || '').trim().slice(0, 120)),
      visibleText: (document.body?.innerText || '').slice(0, 900),
      scripts: [...document.scripts].map(s => s.src).filter(Boolean).slice(0, 8),
    })).catch(() => ({ url: page.url(), title: 'unable to inspect page DOM' }));
    report.summary = 'The expected demo entry button did not appear. Inspect entryPage: this may be a different deployment, a blocked React bundle, or a failed app mount.';
    await page.screenshot({ path: 'journey-failure-' + (process.env.DEVICE_PROFILE || 'desktop') + '.png', fullPage: false }).catch(() => {});
  });
  if (report.failedStep) finish(1);

  await button.click();

  // ── Step 3: did a session actually start? ────────────────────────────
  // Success = the app leaves the entry screen. Failure = the inline error
  // the demo shows, which is deliberately vague to a visitor and therefore
  // useless on its own — the diagnostics below are what explain it.
  const outcome = await Promise.race([
    page
      .getByText(/could not reach the server|could not start a session|not enabled|too many/i)
      .first()
      .waitFor({ state: 'visible', timeout: TIMEOUT_MS })
      .then(() => 'error'),
    page
      .getByRole('button', { name: /generate my code|generar mi código/i })
      .first()
      .waitFor({ state: 'hidden', timeout: TIMEOUT_MS })
      .then(() => 'started'),
  ]).catch(() => 'timeout');

  // Read the app's own always-on diagnostics — the whole point of this
  // check being a browser rather than a curl.
  report.diagnosticsBuffer = await page
    .evaluate(() => (window.__bedeDebugEntries ? window.__bedeDebugEntries() : []))
    .catch(() => []);

  // ── Step 4: can picture study actually show a picture? ───────────────
  // Runs whatever the session outcome was, so a backend problem never
  // hides a picture-study one. See probePictureStudy's own comment for why
  // this does not drive Bede into calling show_visual_aid.
  const probeAid = pickProbeAid();
  if (probeAid) {
    const picture = await probePictureStudy(probeAid).catch((err) => ({
      wikiTitle: probeAid.wiki_title,
      lookupOk: false,
      imageOk: false,
      probeError: String(err),
      violations: [],
    }));
    picture.aidId = probeAid.id;
    // THE distinction this whole step turns on, and the reason it is safe
    // to run unattended every 30 minutes.
    //
    // A CSP refusal is OURS: the deployed policy forbids an origin the app
    // needs, no request was ever sent, and no amount of waiting fixes it.
    // That is a real outage of a real feature and it is repairable from
    // this repository (site/_headers is on the repair agent's allowlist).
    //
    // Wikipedia being slow, rate-limiting, 404ing a renamed article, or
    // unreachable is NOT ours. The demo stays perfectly usable — picture
    // study degrades to the captioned card it is designed to fall back to.
    // Failing the watchdog for that would wake a repair agent for someone
    // else's outage and teach everyone to ignore the alert.
    picture.cspBlocked = (picture.violations || []).some((v) =>
      /wikipedia\.org|wikimedia\.org/i.test(v.blockedURI || '')
    );
    report.pictureStudy = picture;
  } else {
    report.pictureStudy = { skipped: 'visual_aids.json not found next to this script' };
  }

  if (outcome === 'started') {
    const picture = report.pictureStudy || {};
    if (picture.cspBlocked) {
      const directives = [...new Set(picture.violations.map((v) => v.directive))].join(', ');
      report.failedStep = 'picture-study-csp';
      report.summary =
        'A demo session starts, but picture study cannot show a picture: the ' +
        `deployed Content-Security-Policy refused it (${directives}). Every ` +
        'Art & Music card renders "Picture unavailable right now". ' +
        'VisualAidCard.tsx needs BOTH https://en.wikipedia.org in connect-src ' +
        '(the summary lookup) and the image host in img-src (the thumbnail it ' +
        'returns) — allowing only one leaves the identical broken card. Fix ' +
        'the policy in site/_headers; this is a deployment header problem, ' +
        'not a backend outage.';
      finish(1);
    }
    report.ok = true;
    report.summary = 'A demo session started successfully.';
    if (picture.imageOk) {
      report.summary += ` Picture study resolved and rendered "${picture.wikiTitle}" from ${picture.imageHost}.`;
    } else if (picture.skipped) {
      report.summary += ' Picture study was not probed (no catalog next to this script).';
    } else {
      // Reported, deliberately not failed — see cspBlocked above.
      report.summary +=
        ` Picture study could not load "${picture.wikiTitle}" this run, but the ` +
        'policy did not refuse it, so this is Wikimedia being unreachable ' +
        'rather than a Bede problem; the card falls back to its caption. ' +
        'Worth investigating only if it persists across runs.';
    }
    finish(0);
  }

  report.failedStep = outcome === 'timeout' ? 'timeout' : 'generate-code';
  const visible = await page
    .getByText(/could not reach the server|could not start a session|not enabled|too many/i)
    .first()
    .textContent()
    .catch(() => null);

  // Name the cause ONLY when the evidence actually supports it, and say
  // "unknown" otherwise.
  //
  // The first version of this block read "if there are any CSP violations,
  // blame CSP for the backend" — and on its first real run it did exactly
  // that against an unrelated media-src violation on a data: URI, while the
  // true cause (no VITE_DEMO_API_BASE configured) sat in the diagnostics
  // buffer being ignored. A confident wrong answer is worse than no answer
  // anywhere, and considerably worse here: this report is the input to an
  // unattended repair agent, so a misattribution does not merely mislead a
  // human who can push back, it directs an automated change at the wrong
  // file. Attribution is therefore narrow by construction — connect-src
  // specifically, and only when the blocked URI is the thing the app was
  // actually trying to reach.
  const backendBlockedByCsp = report.cspViolations.some(
    (v) => /connect-src/i.test(v) && /\/auth\/|\/tutor\/|onrender\.com/i.test(v)
  );
  // The app's own account of what went wrong, recorded by
  // demo/src/diagnostics.ts before friendlyErrorMessage replaced it with
  // vaguer wording. Preferred over inference wherever it exists.
  const appReported = report.diagnosticsBuffer
    .map((e) => e.message)
    .find((m) => m.startsWith('error→friendly'));

  if (backendBlockedByCsp) {
    report.summary =
      'A Content-Security-Policy blocked the demo from reaching its backend. ' +
      'The request was never sent, so the server logs will show nothing. ' +
      'This is a deployment header problem (site/_headers), not a backend outage.';
  } else if (appReported && /not configured/i.test(appReported)) {
    report.summary =
      'The demo build has no backend URL compiled into it — VITE_DEMO_API_BASE ' +
      'was unset at build time. This is a build/deploy configuration problem, ' +
      'not a runtime failure. (Expected when running the check against a local ' +
      'build; a real deployment sets it.)';
  } else if (report.networkFailures.length) {
    report.summary =
      `The demo could not complete a request: ${report.networkFailures[0].failure}. ` +
      'Check CORS_ORIGINS on the API and that the backend is reachable.';
  } else if (report.requests.some((r) => r.status >= 500)) {
    report.summary = 'The backend returned a server error to the demo.';
  } else {
    // No confident attribution. Report what was seen and say so plainly —
    // the repair agent's prompt requires it to investigate rather than act
    // when the cause is unstated, which only works if this is honest about
    // not knowing.
    report.summary =
      (visible
        ? `The demo showed an error to the visitor: "${visible.trim()}". `
        : 'The demo did not start a session and gave no visible reason. ') +
      'Cause not determined from the browser side — see diagnosticsBuffer, ' +
      'requests and cspViolations below, and check the API logs.';
  }
  if (report.cspViolations.length && !backendBlockedByCsp) {
    // Kept visible but explicitly not blamed, so it is neither hidden nor
    // mistaken for the cause.
    report.summary +=
      ` (Note: ${report.cspViolations.length} unrelated CSP violation(s) were ` +
      'also recorded — not blocking the backend call.)';
  }
  finish(1);
} catch (err) {
  report.failedStep = report.failedStep || 'exception';
  report.summary = `The check itself failed: ${err?.name}: ${err?.message}`;
  finish(1);
} finally {
  await browser.close().catch(() => {});
}
