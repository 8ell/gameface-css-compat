// Renders CSS before and after a transform in Chromium and compares the result:
// element boxes, painted colours (through a canvas, so every colour syntax ends
// up as sRGB bytes), selected computed styles, and the screenshot pixels.
//
// Uses Playwright's Chromium, or CHROME_PATH when set (CI without downloads).

import { chromium } from 'playwright';
import { PNG } from 'pngjs';

let browserPromise;

export async function getBrowser() {
  if (!browserPromise) {
    const executablePath = process.env.CHROME_PATH || undefined;
    browserPromise = chromium.launch({
      executablePath,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', ...(executablePath ? ['--no-zygote'] : [])],
    });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (browserPromise) (await browserPromise).close();
  browserPromise = undefined;
}

const COLOR_PROPS = ['color', 'background-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'outline-color', 'text-decoration-color'];
const OTHER_PROPS = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'font-size', 'font-weight', 'line-height', 'text-align',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-left-radius', 'border-bottom-right-radius',
  'flex-direction', 'flex-wrap', 'row-gap', 'column-gap', 'opacity', 'transform', 'width', 'height', 'max-width', 'max-height',
];

/**
 * @param {import('playwright').Page} page
 * @param {string} css
 * @param {string} html
 */
async function snapshot(page, css, html) {
  await page.setContent(`<!doctype html><html><head><style>html,body{margin:0}${css}</style></head><body>${html}</body></html>`);
  return page.evaluate(({ COLOR_PROPS, OTHER_PROPS }) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    const bytes = (c) => {
      g.clearRect(0, 0, 1, 1);
      g.fillStyle = '#000';
      g.fillStyle = c;
      g.fillRect(0, 0, 1, 1);
      return Array.from(g.getImageData(0, 0, 1, 1).data);
    };
    return [...document.querySelectorAll('body *')].map((el, i) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const colors = Object.fromEntries(COLOR_PROPS.map((p) => [p, bytes(cs.getPropertyValue(p))]));
      const other = Object.fromEntries(OTHER_PROPS.map((p) => [p, cs.getPropertyValue(p)]));
      return { i, tag: el.tagName.toLowerCase(), cls: el.className, rect: [r.x, r.y, r.width, r.height], colors, other };
    });
  }, { COLOR_PROPS, OTHER_PROPS });
}

/** Parses numbers out of computed values so float noise does not fail a comparison. */
function numbers(s) {
  return (String(s).match(/-?\d*\.?\d+(e-?\d+)?/gi) ?? []).map(Number);
}

function sameValue(a, b) {
  if (a === b) return true;
  const na = numbers(a);
  const nb = numbers(b);
  if (na.length === 0 || na.length !== nb.length) return false;
  if (String(a).replace(/-?\d*\.?\d+(e-?\d+)?/gi, '#') !== String(b).replace(/-?\d*\.?\d+(e-?\d+)?/gi, '#')) return false;
  return na.every((x, i) => Math.abs(x - nb[i]) <= 1e-3 * Math.max(1, Math.abs(x)));
}

/**
 * @param {Buffer} a
 * @param {Buffer} b
 */
function pixelDiff(a, b) {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return Infinity;
  let diff = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    if (Math.abs(pa.data[i] - pb.data[i]) > 2 || Math.abs(pa.data[i + 1] - pb.data[i + 1]) > 2 || Math.abs(pa.data[i + 2] - pb.data[i + 2]) > 2 || Math.abs(pa.data[i + 3] - pb.data[i + 3]) > 2) diff++;
  }
  return diff;
}

/**
 * Compares rendering of two stylesheets for the same HTML.
 * @param {{ before: string, after: string, html: string, viewports?: Array<[number, number]>, ignore?: string[] }} c
 * @returns {Promise<string[]>} human-readable differences (empty when identical)
 */
export async function compareRender({ before, after, html, viewports = [[1280, 720]], ignore = [] }) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  const problems = [];
  try {
    for (const [w, h] of viewports) {
      await page.setViewportSize({ width: w, height: h });
      const a = await snapshot(page, before, html);
      const shotA = await page.screenshot({ fullPage: true });
      const b = await snapshot(page, after, html);
      const shotB = await page.screenshot({ fullPage: true });
      for (let i = 0; i < a.length; i++) {
        const ea = a[i];
        const eb = b[i];
        const label = `@${w}px <${ea.tag} class="${ea.cls}">`;
        ea.rect.forEach((v, k) => {
          if (Math.abs(v - eb.rect[k]) > 0.02) problems.push(`${label} box ${['x', 'y', 'w', 'h'][k]}: ${v} vs ${eb.rect[k]}`);
        });
        for (const [p, ca] of Object.entries(ea.colors)) {
          if (ignore.includes(p)) continue;
          const cb = eb.colors[p];
          if (ca.some((v, k) => Math.abs(v - cb[k]) > 1)) problems.push(`${label} ${p}: ${ca} vs ${cb}`);
        }
        for (const [p, va] of Object.entries(ea.other)) {
          if (ignore.includes(p)) continue;
          if (!sameValue(va, eb.other[p])) problems.push(`${label} ${p}: ${va} vs ${eb.other[p]}`);
        }
      }
      const px = pixelDiff(shotA, shotB);
      if (px > 0) problems.push(`@${w}px screenshot differs in ${px} pixels`);
    }
  } finally {
    await page.close();
  }
  return problems;
}

/**
 * Evaluates a script in a page that has the given CSS and HTML.
 * @param {string} css
 * @param {string} html
 * @param {(arg: any) => any} fn
 * @param {any} [arg]
 */
export async function evaluateWith(css, html, fn, arg) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html><html><head><style>html,body{margin:0}${css}</style></head><body>${html}</body></html>`);
    return await page.evaluate(fn, arg);
  } finally {
    await page.close();
  }
}
