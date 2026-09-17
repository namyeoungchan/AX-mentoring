import { chromium } from '../../lms-web/node_modules/playwright/index.mjs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFile } from 'node:fs/promises'
const root = dirname(fileURLToPath(import.meta.url))
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
const checks = []
try {
  for (const name of ['admin-guide', 'mentor-guide', 'student-guide']) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } })
    await page.goto(pathToFileURL(join(root, 'output', name + '.html')).href)
    await page.emulateMedia({ media: 'print' })
    await page.evaluate(() => document.fonts.ready)
    const layout = await page.evaluate(() => [...document.querySelectorAll('.page')].map((p, i) => {
      const content = p.querySelector('main').getBoundingClientRect(), footer = p.querySelector('footer').getBoundingClientRect()
      const overflow = [...p.querySelectorAll('main *')].filter(e => e.getBoundingClientRect().right > p.getBoundingClientRect().right - 30 || e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).display !== 'inline' && !e.matches('.flow > li')).map(e => e.tagName + '.' + e.className).filter(x => !x.includes('SVGAnimatedString'))
      return { page: i + 1, remainingSpace: Math.round(footer.top - content.bottom), overflow }
    }))
    checks.push({ name, layout })
    if (layout.some(p => p.remainingSpace < 10 || p.overflow.length)) throw new Error(name + ': ' + JSON.stringify(layout))
    await page.pdf({ path: join(root, 'output', name + '.pdf'), preferCSSPageSize: true, printBackground: true, tagged: true, outline: true })
    await page.close()
  }
} finally {
  await writeFile(join(root, 'output', 'layout-checks.json'), JSON.stringify(checks, null, 2))
  await browser.close()
}
console.log(JSON.stringify(checks))
