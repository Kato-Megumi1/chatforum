// One untrusted document per disposable, non-root, network-none container.
// No mounts, browser profile, credentials or authenticated application context.
'use strict';
const { createHash } = require('node:crypto');
const { chromium } = require('playwright-core');
const VERSION = 'offline-html-v1';
const ORIGIN = 'https://artifact.invalid/';
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
const safeText = value => String(value).replace(/[\u0000-\u001f]/g, ' ').slice(0, 300);
async function render(job) {
  if (process.getuid?.() === 0) throw new Error('ROOT_FORBIDDEN');
  if (!job || !/^[a-f0-9-]{36}$/.test(job.id) || typeof job.html !== 'string' || Buffer.byteLength(job.html) > 64000 ||
    createHash('sha256').update(job.html).digest('hex') !== job.sourceHash || !Array.isArray(job.viewports) || job.viewports.length !== 2 ||
    JSON.stringify(job.viewports) !== JSON.stringify([{width:390,height:844},{width:1280,height:900}])) throw new Error('INVALID_JOB');
  const browser = await chromium.launch({ executablePath:'/usr/bin/chromium', headless:true, chromiumSandbox:true,
    args:['--disable-setuid-sandbox','--disable-gpu','--disable-software-rasterizer','--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run',
      '--disable-extensions','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--js-flags=--max-old-space-size=96'], timeout:12000 });
  const views=[];
  try {
    for (const viewport of job.viewports) {
      // CSP's opaque sandbox + worker-src none already forbid service workers.
      // Playwright's serviceWorkers:block injector reads the forbidden getter
      // itself and otherwise creates a spurious page error on every document.
      const context = await browser.newContext({ viewport, acceptDownloads:false, permissions:[],
        offline:true, javaScriptEnabled:true, bypassCSP:false, locale:'zh-CN' });
      let allowed=false, blockedRequests=0;
      await context.route('**/*', route => {
        if (!allowed && route.request().isNavigationRequest() && route.request().url()===ORIGIN) {
          allowed=true;return route.fulfill({status:200,contentType:'text/html; charset=utf-8',headers:{'Content-Security-Policy':CSP,'X-Content-Type-Options':'nosniff'},body:job.html});
        }
        blockedRequests++;return route.abort('blockedbyclient');
      });
      await context.routeWebSocket('**/*', socket => {blockedRequests++;socket.close();});
      await context.addInitScript(() => {
        for (const key of ['RTCPeerConnection','webkitRTCPeerConnection','WebTransport']) {
          try {Object.defineProperty(globalThis,key,{value:undefined,writable:false,configurable:false});} catch {}
        }
      });
      const page=await context.newPage(), pageErrors=[], consoleErrors=[];
      context.on('page', popup => {if(popup!==page)void popup.close();});
      page.on('dialog', dialog => {void dialog.dismiss();});
      page.on('download', download => {void download.cancel();});
      page.on('pageerror', error => {if(pageErrors.length<8)pageErrors.push(safeText(error.message));});
      page.on('console', message => {if(message.type()==='error'&&consoleErrors.length<8)consoleErrors.push(safeText(message.text()));});
      try {
        await page.goto(ORIGIN,{waitUntil:'domcontentloaded',timeout:8000});
        await page.waitForTimeout(700);
        if(page.url().split('#')[0]!==ORIGIN)throw new Error('NAVIGATION_BLOCKED');
        const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
        const png=await page.screenshot({type:'png',fullPage:false,timeout:5000,caret:'hide'});
        if(png.length>2*1024*1024)throw new Error('IMAGE_TOO_LARGE');
        views.push({...viewport,png:png.toString('base64'),overflow,pageErrors,consoleErrors,blockedRequests});
      } finally {await context.close();}
    }
    return {id:job.id,sourceHash:job.sourceHash,rendererVersion:VERSION,status:'rendered',views};
  } finally {await browser.close();}
}
async function main(){
  process.stdin.setEncoding('utf8');
  let raw='';for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>512000)throw new Error('INVALID_JOB');}
  return render(JSON.parse(raw));
}
// The external launcher kills the whole container on deadline, including infinite-loop renderers.
main().then(value=>process.stdout.write(JSON.stringify(value))).catch(error=>{
  if(process.env.ARTIFACT_REVIEW_DEBUG==='1')process.stderr.write(String(error.message).slice(0,2000));
  process.stdout.write(JSON.stringify({rendererVersion:VERSION,status:'failed',error:'RENDER_FAILED'}));process.exitCode=1;
});
