const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 415, height: 800, deviceScaleFactor: 2 });
    
    const filePath = 'file://' + path.resolve('index.html').replace(/\\/g, '/');
    await page.goto(filePath, { waitUntil: 'networkidle2' });

    // Scroll down 500px
    await page.evaluate(() => {
        window.scrollTo(0, 500);
    });

    // Wait a bit
    await new Promise(r => setTimeout(r, 200));

    // Capture the viewport to see if the navbar is present at the top
    await page.screenshot({ path: 'test_scroll_viewport.png' });
    console.log('Saved test_scroll_viewport.png');

    await browser.close();
})();
