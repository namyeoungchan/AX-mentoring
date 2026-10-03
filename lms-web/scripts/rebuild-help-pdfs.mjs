// Rebuild PDF text/layout from already captured images without touching any LMS data.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { HELP_GUIDES } from '../server/help-catalog.mjs';
import { renderGuidePdf } from './render-help-pdf.mjs';

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
try {
  const page = await browser.newPage();
  for (const guide of HELP_GUIDES) {
    const images = await Promise.all(guide.steps.map(async (step, i) => step.imageAvailable === false ? null : (await readFile(`server/help-assets/${guide.id}-step-${i + 1}.jpg`)).toString('base64')));
    await page.setContent(renderGuidePdf(guide, images));
    await page.evaluate(() => document.fonts.ready);
    const overflow = await page.locator('.sheet').evaluateAll(nodes => nodes.some(n => {
      const footer = n.querySelector('footer').getBoundingClientRect();
      const last = (n.querySelector('.note') || n.querySelector('.capture-pending') || n.querySelector('.instruction')).getBoundingClientRect();
      return n.scrollHeight > n.clientHeight + 2 || last.bottom + 5 > footer.top;
    }));
    if (overflow) throw new Error(`PDF footer overlap: ${guide.id}`);
    await page.pdf({ path: `server/help-assets/${guide.id}.pdf`, format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true });
  }
  console.log(`Rebuilt ${HELP_GUIDES.length} PDFs; no footer overlap.`);
} finally { await browser.close(); }
