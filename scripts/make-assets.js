// Generates the PWA icon set + iOS splash screens (black & red) with headless Chrome.
// Usage: node scripts/make-assets.js   (CHROME=/path/to/chrome to override)
const { chromium } = require('playwright-core');
const fs = require('fs'), path = require('path');
const PUB = path.join(__dirname, '..', 'public');
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';

// mascot: red blob with two peeking eyes, drawn in SVG (no emoji, so it renders the same everywhere)
const mascot = (cx, cy, r) => `
  <defs><radialGradient id="g" cx="40%" cy="35%" r="75%"><stop offset="0" stop-color="#FF5A6E"/><stop offset="1" stop-color="#D90F2C"/></radialGradient>
  <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${r * 0.12}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
  <rect x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" rx="${r * 0.62}" fill="url(#g)" filter="url(#glow)"/>
  <ellipse cx="${cx - r * 0.36}" cy="${cy - r * 0.05}" rx="${r * 0.27}" ry="${r * 0.34}" fill="#fff"/>
  <ellipse cx="${cx + r * 0.36}" cy="${cy - r * 0.05}" rx="${r * 0.27}" ry="${r * 0.34}" fill="#fff"/>
  <circle cx="${cx - r * 0.27}" cy="${cy + r * 0.03}" r="${r * 0.14}" fill="#000"/>
  <circle cx="${cx + r * 0.45}" cy="${cy + r * 0.03}" r="${r * 0.14}" fill="#000"/>
  <circle cx="${cx - r * 0.22}" cy="${cy - r * 0.03}" r="${r * 0.045}" fill="#fff"/>
  <circle cx="${cx + r * 0.5}" cy="${cy - r * 0.03}" r="${r * 0.045}" fill="#fff"/>`;
const iconSvg = (scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#000"/>${mascot(256, 256, 256 * scale)}</svg>`;

(async () => {
  fs.mkdirSync(path.join(PUB, 'icons'), { recursive: true });
  fs.mkdirSync(path.join(PUB, 'splash'), { recursive: true });
  fs.writeFileSync(path.join(PUB, 'icon.svg'), iconSvg(0.62));
  const b = await chromium.launch({ executablePath: CHROME });
  const page = await b.newPage();
  const render = async (svg, size, file) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:#000">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: path.join(PUB, 'icons', file), omitBackground: false });
  };
  for (const s of [48, 72, 96, 128, 144, 192, 256, 384, 512]) await render(iconSvg(0.62), s, `icon-${s}.png`);
  for (const s of [192, 512]) await render(iconSvg(0.46), s, `maskable-${s}.png`); // stays inside the 80% safe zone
  await render(iconSvg(0.58), 180, 'apple-touch-icon.png');
  await render(iconSvg(0.66), 32, 'favicon-32.png');

  const devices = [[440, 956, 3], [402, 874, 3], [430, 932, 3], [393, 852, 3], [428, 926, 3], [390, 844, 3], [375, 812, 3], [414, 896, 3], [414, 896, 2], [414, 736, 3], [375, 667, 2]];
  const links = [];
  for (const [w, h, dpr] of devices) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
    const p = await ctx.newPage();
    await p.setContent(`<html><body style="margin:0;width:${w}px;height:${h}px;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:'Avenir Next',Roboto,Helvetica,Arial,sans-serif;color:#fff">
      <svg width="${w * 0.36}" height="${w * 0.36}" viewBox="0 0 512 512">${mascot(256, 256, 200)}</svg>
      <div style="font-size:${w * 0.1}px;font-weight:900;letter-spacing:-1px;margin-top:${w * 0.04}px"><span style="color:#FF2D46">P</span>eekaSnap</div>
      <div style="font-size:${w * 0.038}px;color:#bbb;margin-top:6px">Snap it. Hide it. Hunt it.</div></body></html>`);
    const file = `splash-${w * dpr}x${h * dpr}.png`;
    await p.screenshot({ path: path.join(PUB, 'splash', file) });
    links.push(`<link rel="apple-touch-startup-image" media="(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait)" href="/splash/${file}">`);
    await ctx.close();
  }
  fs.writeFileSync(path.join(__dirname, 'splash-links.html'), links.join('\n') + '\n'); // paste into index.html <head>
  await b.close();
  console.log('icons + splash screens written');
})();
