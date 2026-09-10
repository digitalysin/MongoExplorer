/**
 * Renders build/icon.png with Electron so the project needs no image tooling.
 * electron-builder converts it to .icns/.ico automatically.
 *
 *   npm run icon
 */
import { BrowserWindow, app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const SIZE = 1024;

const markup = `
<!doctype html>
<html>
  <body style="margin:0;background:transparent">
    <svg width="${SIZE}" height="${SIZE}" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#232936" />
          <stop offset="100%" stop-color="#11141a" />
        </linearGradient>
        <linearGradient id="leaf" x1="0.2" y1="0" x2="0.8" y2="1">
          <stop offset="0%" stop-color="#6fe08d" />
          <stop offset="100%" stop-color="#2f8f4d" />
        </linearGradient>
      </defs>

      <rect width="1024" height="1024" rx="224" fill="url(#bg)" />

      <path
        d="M512 168c96 118 150 226 150 322 0 118-66 196-150 232-84-36-150-114-150-232 0-96 54-204 150-322z"
        fill="url(#leaf)" />
      <path d="M494 190h36c0 0 16 254 16 532h-36c0-278-16-532-16-532z" fill="#11141a" opacity="0.4" />

      <g fill="none" stroke="#8f9ab2" stroke-width="26" stroke-linecap="round">
        <line x1="286" y1="812" x2="738" y2="812" />
        <line x1="286" y1="884" x2="600" y2="884" />
      </g>
    </svg>
  </body>
</html>
`;

async function render() {
  const window = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    frame: false,
    useContentSize: true,
    show: false,
    backgroundColor: '#00000000'
  });

  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(markup)}`);
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Capture explicitly, then normalise the HiDPI backing scale away.
  const captured = await window.webContents.capturePage({
    x: 0,
    y: 0,
    width: SIZE,
    height: SIZE
  });
  const image = captured.resize({ width: SIZE, height: SIZE });
  const outputDir = path.resolve('build');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'icon.png'), image.toPNG());
  console.log(`wrote build/icon.png (${image.getSize().width}x${image.getSize().height})`);
  app.exit(0);
}

void app.whenReady().then(() =>
  render().catch((error) => {
    console.error(error);
    app.exit(1);
  })
);
