// Exercises extension/inject.js against simulated pop-up and redirect tricks.
// Run: node tests/inject.test.js   (needs Playwright with Chromium)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const GUARD = fs.readFileSync(path.join(__dirname, '../extension/inject.js'), 'utf8');
const HOME = 'https://news.example/';
const AD = 'https://ads.badnet.test/landing';

const PAGE = `<!doctype html><html><head><meta name=viewport content="width=device-width"></head><body style="margin:0">
  <h1 id="title">Article</h1>
  <button id="btn" style="width:200px;height:60px">Play video</button>
  <a id="real" href="https://partner.test/page" target="_blank" style="display:block;height:40px">Partner link</a>
  <a id="swap" href="https://news.example/next" style="display:block;height:40px">Next page</a>
  <a id="internal" href="/story" style="display:block;height:40px">Story</a>
  <button id="login" style="width:200px;height:40px">Sign in with Google</button>
  <button id="share" style="width:200px;height:40px">Share</button>
  <p id="text" style="height:60px">Some article text</p>
</body></html>`;

async function setup(browser, config) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await context.route('**/*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: route.request().url().startsWith(HOME) ? PAGE : '<p>other</p>' })
  );
  await context.addInitScript(GUARD);
  if (config) {
    await context.addInitScript((cfg) => {
      window.dispatchEvent(new CustomEvent('popblock:config', { detail: JSON.stringify(cfg) }));
    }, config);
  }
  await context.addInitScript(() => {
    window.__reports = [];
    window.addEventListener('popblock:report', (e) => window.__reports.push(JSON.parse(e.detail)));
  });
  const page = await context.newPage();
  await page.goto(HOME);
  const popups = [];
  context.on('page', (p) => popups.push(p));
  return { context, page, popups };
}

const settle = (page) => page.waitForTimeout(300);
const kinds = (page) => page.evaluate(() => window.__reports.map((r) => r.kind));

const tests = {
  async 'window.open with no tap is blocked and returns a fake window'(b) {
    const { page, popups, context } = await setup(b);
    const result = await page.evaluate((ad) => {
      const w = window.open(ad);
      return { got: !!w, closed: w.closed };
    }, AD);
    await settle(page);
    assert.deepStrictEqual(result, { got: true, closed: false });
    assert.strictEqual(popups.length, 0);
    assert.ok((await kinds(page)).includes('popup'));
    await context.close();
  },

  async 'pop-under fired by a tap on page text is blocked'(b) {
    const { page, popups, context } = await setup(b);
    await page.evaluate((ad) => document.addEventListener('click', () => window.open(ad)), AD);
    await page.click('#text');
    await settle(page);
    assert.strictEqual(popups.length, 0);
    await context.close();
  },

  async 'pop-under fired by a tap on a button is blocked in strict mode'(b) {
    const { page, popups, context } = await setup(b);
    await page.evaluate((ad) => document.addEventListener('click', () => window.open(ad)), AD);
    await page.click('#btn');
    await settle(page);
    assert.strictEqual(popups.length, 0);
    await context.close();
  },

  async 'button pop-up to another site is allowed when strict mode is off'(b) {
    const { page, popups, context } = await setup(b, { enabled: true, strict: false });
    await page.evaluate(() => document.getElementById('share').addEventListener('click', () => window.open('https://social.test/share')));
    await page.click('#share');
    await settle(page);
    assert.strictEqual(popups.length, 1);
    await context.close();
  },

  async 'sign-in pop-up from a button is allowed'(b) {
    const { page, popups, context } = await setup(b);
    await page.evaluate(() =>
      document.getElementById('login').addEventListener('click', () => window.open('https://accounts.google.com/o/oauth2', 'login', 'width=500'))
    );
    await page.click('#login');
    await settle(page);
    assert.strictEqual(popups.length, 1);
    await context.close();
  },

  async 'same-site pop-up from a tap is allowed'(b) {
    const { page, popups, context } = await setup(b);
    await page.evaluate(() => document.getElementById('btn').addEventListener('click', () => window.open('/player')));
    await page.click('#btn');
    await settle(page);
    assert.strictEqual(popups.length, 1);
    await context.close();
  },

  async 'a real tap on a target=_blank link still opens it'(b) {
    const { page, popups, context } = await setup(b);
    await page.click('#real');
    await settle(page);
    assert.strictEqual(popups.length, 1);
    await context.close();
  },

  async 'script-clicked hidden ad link is blocked'(b) {
    const { page, popups, context } = await setup(b);
    await page.evaluate((ad) => {
      const a = document.createElement('a');
      a.href = ad;
      a.target = '_blank';
      a.click();
      const a2 = document.createElement('a');
      a2.href = ad;
      a2.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, AD);
    await settle(page);
    assert.strictEqual(popups.length, 0);
    assert.strictEqual(page.url(), HOME);
    await context.close();
  },

  async 'script form submit to an ad site is blocked'(b) {
    const { page, context } = await setup(b);
    await page.evaluate((ad) => {
      const f = document.createElement('form');
      f.action = ad;
      document.body.appendChild(f);
      f.submit();
    }, AD);
    await settle(page);
    assert.strictEqual(page.url(), HOME);
    await context.close();
  },

  async 'link swapped on finger-down goes to the original destination'(b) {
    const { page, context } = await setup(b);
    await page.evaluate((ad) => {
      document.getElementById('swap').addEventListener('mousedown', (e) => (e.currentTarget.href = ad));
    }, AD);
    await Promise.all([page.waitForURL('https://news.example/next'), page.click('#swap')]);
    assert.strictEqual(page.url(), 'https://news.example/next');
    await context.close();
  },

  async 'invisible full-screen ad link layer is removed and the tap is stopped'(b) {
    const { page, popups, context } = await setup(b);
    await page.evaluate((ad) => {
      const a = document.createElement('a');
      a.id = 'layer';
      a.href = ad;
      a.target = '_blank';
      a.style.cssText = 'position:fixed;inset:0;z-index:2147483647;opacity:0';
      document.body.appendChild(a);
      window.__btn = 0;
      document.getElementById('btn').addEventListener('click', () => window.__btn++);
    }, AD);
    await page.mouse.click(100, 100);
    await settle(page);
    assert.strictEqual(popups.length, 0);
    assert.strictEqual(await page.$eval('#layer', (el) => getComputedStyle(el).display), 'none');
    // The next tap reaches the real page.
    await page.click('#btn');
    assert.strictEqual(await page.evaluate(() => window.__btn), 1);
    await context.close();
  },

  async 'transparent div that triggers a pop-up is removed after the first tap'(b) {
    const { page, popups, context } = await setup(b);
    await page.evaluate((ad) => {
      const d = document.createElement('div');
      d.id = 'layer';
      d.style.cssText = 'position:fixed;inset:0;z-index:99999';
      d.addEventListener('click', () => window.open(ad));
      document.body.appendChild(d);
    }, AD);
    await page.mouse.click(100, 100);
    await settle(page);
    assert.strictEqual(popups.length, 0);
    assert.strictEqual(await page.$eval('#layer', (el) => getComputedStyle(el).display), 'none');
    await context.close();
  },

  async 'visible modal dialogs are left alone'(b) {
    const { page, context } = await setup(b);
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.id = 'modal';
      d.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.5)';
      d.innerHTML = '<div style="background:#fff">Accept cookies? <button>OK</button></div>';
      document.body.appendChild(d);
    });
    await page.mouse.click(200, 400);
    await settle(page);
    assert.strictEqual(await page.$eval('#modal', (el) => getComputedStyle(el).display), 'block');
    await context.close();
  },

  async 'internal links work normally'(b) {
    const { page, context } = await setup(b);
    await Promise.all([page.waitForURL('https://news.example/story'), page.click('#internal')]);
    await context.close();
  },

  async 'notification permission prompt is denied in strict mode'(b) {
    const { page, context } = await setup(b);
    // Headless Chromium starts at "denied"; simulate a fresh site that may prompt.
    const res = await page.evaluate(() => {
      Object.defineProperty(Notification, 'permission', { get: () => 'default' });
      return Notification.requestPermission();
    });
    assert.strictEqual(res, 'denied');
    await context.close();
  },

  async 'alert spam is cut off after two dialogs'(b) {
    const { page, context } = await setup(b);
    let dialogs = 0;
    page.on('dialog', (d) => {
      dialogs++;
      d.dismiss();
    });
    await page.evaluate(() => {
      for (let i = 0; i < 6; i++) alert('You won an iPhone!');
    });
    assert.strictEqual(dialogs, 2);
    await context.close();
  },

  async 'back-button trap stops adding history entries'(b) {
    const { page, context } = await setup(b);
    const len = await page.evaluate(() => {
      const start = history.length;
      for (let i = 0; i < 20; i++) history.pushState({}, '', '#trap' + i);
      return history.length - start;
    });
    assert.strictEqual(len, 3);
    await context.close();
  },

  async 'banner-sized image linking off-site is hidden'(b) {
    const { page, context } = await setup(b);
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<a id="banner" href="https://game.sponsor.test/play?aff=1" target="_blank"><img src="/b.png" width="290" height="242"></a>' +
          '<a id="photo" href="https://photos.test/album"><img src="/p.png" width="390" height="390"></a>' +
          '<a id="textlink" href="https://partner.test/"><img src="/i.png" width="300" height="250"> Read on Partner</a>' +
          '<a id="local" href="/gallery"><img src="/g.png" width="300" height="250"></a>'
      );
    });
    await page.waitForTimeout(600);
    const shown = await page.evaluate(() =>
      ['banner', 'photo', 'textlink', 'local'].map((id) => getComputedStyle(document.getElementById(id)).display !== 'none')
    );
    assert.deepStrictEqual(shown, [false, true, true, true]);
    await context.close();
  },

  async 'ad network frames, images and links are hidden'(b) {
    const { page, context } = await setup(b);
    // Parsed HTML, like ads that are part of the page itself.
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<a id="l" href="https://a.magsrv.com/click?x=1">Hot games</a>' +
          '<iframe id="static" src="https://syndication.exoclick.com/ad" width="300" height="250"></iframe>' +
          '<iframe id="video" src="https://video.test/embed" width="300" height="250" allowfullscreen></iframe>'
      );
    });
    await page.waitForTimeout(600);
    const hidden = await page.evaluate(() =>
      ['l', 'static', 'video'].map((id) => getComputedStyle(document.getElementById(id)).display === 'none')
    );
    assert.deepStrictEqual(hidden, [true, true, false]);
    await context.close();
  },

  async 'ad scripts and frames added by script never load'(b) {
    const { page, context } = await setup(b);
    const srcs = await page.evaluate(() => {
      const s = document.createElement('script');
      s.src = 'https://a.magsrv.com/ad-provider.js';
      const f = document.createElement('iframe');
      f.setAttribute('src', 'https://ads.exoclick.com/frame');
      const ok = document.createElement('script');
      ok.src = 'https://news.example/app.js';
      return [s.getAttribute('src'), f.getAttribute('src'), ok.getAttribute('src')];
    });
    assert.deepStrictEqual(srcs, [null, null, 'https://news.example/app.js']);
    await context.close();
  },

  async 'video thumbnail link: blank pop-up later pointed at an ad is blocked'(b) {
    const { page, popups, context } = await setup(b);
    await page.evaluate((ad) => {
      document.body.insertAdjacentHTML('beforeend', '<a id="thumb" href="/v/123" style="display:block;width:300px;height:170px;background:#333"></a>');
      document.addEventListener('click', (e) => {
        e.preventDefault();
        const w = window.open('', '_blank');
        if (w) w.location = ad;
      }, true);
    }, AD);
    await page.click('#thumb');
    await settle(page);
    assert.strictEqual(popups.length, 0);
    await context.close();
  },

  async 'ad link slipped under the finger during the tap is blocked'(b) {
    const { page, popups, context } = await setup(b);
    await page.evaluate((ad) => {
      document.body.insertAdjacentHTML('beforeend', '<video id="vid" style="display:block;width:300px;height:170px;background:#000"></video>');
      const v = document.getElementById('vid');
      v.addEventListener('touchstart', () => {
        const r = v.getBoundingClientRect();
        const a = document.createElement('a');
        a.id = 'slip';
        a.href = ad;
        a.target = '_blank';
        a.textContent = ' ';
        a.style.cssText = `position:absolute;left:${r.left + scrollX}px;top:${r.top + scrollY}px;width:${r.width}px;height:${r.height}px;z-index:9`;
        document.body.appendChild(a);
      });
    }, AD);
    // A touch tap, as on iPhone: the click goes to whatever is under the
    // finger when it lifts.
    await page.tap('#vid');
    await settle(page);
    assert.ok(await page.$('#slip'), 'test setup: the ad link was inserted');
    assert.strictEqual(popups.length, 0);
    await context.close();
  },

  async 'small invisible ad link over the video player is blocked'(b) {
    const { page, popups, context } = await setup(b);
    await page.evaluate((ad) => {
      document.body.insertAdjacentHTML(
        'beforeend',
        `<div style="position:relative;width:300px;height:170px"><video style="width:100%;height:100%;background:#000"></video>` +
          `<a id="ghost" href="${ad}" target="_blank" style="position:absolute;inset:0;z-index:5"></a></div>`
      );
    }, AD);
    await page.click('#ghost');
    await settle(page);
    assert.strictEqual(popups.length, 0);
    await context.close();
  },

  async 'untouched window.open borrowed from a hidden frame is still guarded'(b) {
    const { page, popups, context } = await setup(b);
    await page.evaluate((ad) => {
      const f = document.createElement('iframe');
      f.style.display = 'none';
      document.body.appendChild(f);
      f.contentWindow.open(ad);
      window.frames[0].open(ad);
      f.contentWindow.HTMLElement.prototype.click.call(Object.assign(document.createElement('a'), { href: ad, target: '_blank' }));
    }, AD);
    await settle(page);
    assert.strictEqual(popups.length, 0);
    await context.close();
  },

  async 'HTMLElement.prototype.click on an ad link is blocked'(b) {
    const { page, popups, context } = await setup(b);
    await page.evaluate((ad) => {
      const a = document.createElement('a');
      a.href = ad;
      a.target = '_blank';
      HTMLElement.prototype.click.call(a);
    }, AD);
    await settle(page);
    assert.strictEqual(popups.length, 0);
    await context.close();
  },

  async 'tab redirected to an ad after tapping play is stopped'(b) {
    const { page, context } = await setup(b);
    await page.evaluate((ad) => {
      document.getElementById('btn').addEventListener('click', () => (location.href = ad));
    }, AD);
    await page.click('#btn');
    await page.waitForTimeout(500);
    assert.strictEqual(page.url(), HOME);
    await context.close();
  },

  async 'redirect after tapping page text is stopped'(b) {
    const { page, context } = await setup(b);
    await page.evaluate(() => document.addEventListener('click', () => location.assign('https://unknown-ads.test/x')));
    await page.click('#text');
    await page.waitForTimeout(500);
    assert.strictEqual(page.url(), HOME);
    await context.close();
  },

  async 'automatic redirect with no tap still works (e.g. moved site)'(b) {
    const { page, context } = await setup(b);
    await Promise.all([page.waitForURL('https://new-domain.test/'), page.evaluate(() => (location.href = 'https://new-domain.test/'))]);
    await context.close();
  },

  async 'sign-in redirect from a button still works'(b) {
    const { page, context } = await setup(b);
    await page.evaluate(() =>
      document.getElementById('login').addEventListener('click', () => (location.href = 'https://accounts.google.com/signin'))
    );
    await Promise.all([page.waitForURL('https://accounts.google.com/signin'), page.click('#login')]);
    await context.close();
  },

  async 'a real visible link to another site still works'(b) {
    const { page, context } = await setup(b);
    await page.evaluate(() =>
      document.body.insertAdjacentHTML('beforeend', '<a id="out" href="https://wikipedia.test/wiki" style="display:block;height:40px">Wikipedia</a>')
    );
    await Promise.all([page.waitForURL('https://wikipedia.test/wiki'), page.click('#out')]);
    await context.close();
  },

  async 'paused site (enabled: false) is not touched'(b) {
    const { page, popups, context } = await setup(b, { enabled: false, strict: true });
    await page.evaluate((ad) => window.open(ad), AD);
    await settle(page);
    assert.strictEqual(popups.length, 1);
    await context.close();
  },

  async 'a page script cannot switch the guard off'(b) {
    const { page, popups, context } = await setup(b, { enabled: true, strict: true });
    await page.evaluate((ad) => {
      window.dispatchEvent(new CustomEvent('popblock:config', { detail: '{"enabled":false}' }));
      window.open(ad);
    }, AD);
    await settle(page);
    assert.strictEqual(popups.length, 0);
    await context.close();
  },
};

(async () => {
  const browser = await chromium.launch();
  let failed = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn(browser);
      console.log('  ok   ' + name);
    } catch (e) {
      failed++;
      console.log('  FAIL ' + name + '\n       ' + e.message.split('\n')[0]);
    }
  }
  await browser.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
