const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 415, height: 843 });
    
    const filePath = 'file://' + path.resolve('index.html').replace(/\\/g, '/');
    await page.goto(filePath, { waitUntil: 'networkidle2' });

    const ancestors = await page.evaluate(() => {
        let el = document.querySelector('#giangvien .column-14 > div[style*="max-width:580px"] > div:first-child');
        const list = [];
        while (el) {
            const computed = window.getComputedStyle(el);
            list.push({
                tag: el.tagName,
                id: el.id,
                className: el.className,
                styleAttr: el.getAttribute('style'),
                height: computed.height,
                minHeight: computed.minHeight,
                maxHeight: computed.maxHeight,
                display: computed.display,
                position: computed.position,
                margin: computed.margin,
                padding: computed.padding
            });
            el = el.parentElement;
        }
        return list;
    });

    console.log(JSON.stringify(ancestors, null, 2));
    await browser.close();
})();
