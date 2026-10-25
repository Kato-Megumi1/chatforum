// Anonymous, read-only measurements. No login credentials, chat content or paid model calls.
const {chromium}=require('playwright');
const pageUrl='https://kato-megumi1.github.io/chatforum-web/#/login';
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
for(const slow of [false,true]){const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const page=await context.newPage(),cdp=await context.newCDPSession(page);
await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
if(slow){await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:150,downloadThroughput:1.6*1024*1024/8,uploadThroughput:750*1024/8});await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});}
await page.addInitScript(()=>{window.__perf={longTasks:[],lcp:0};new PerformanceObserver(list=>{window.__perf.longTasks.push(...list.getEntries().map(x=>Math.round(x.duration)));}).observe({type:'longtask',buffered:true});new PerformanceObserver(list=>{window.__perf.lcp=list.getEntries().at(-1)?.startTime||0;}).observe({type:'largest-contentful-paint',buffered:true});});
await page.goto(pageUrl,{waitUntil:'load',timeout:90000});await page.locator('input[type=password]').waitFor({timeout:30000});await page.waitForLoadState('networkidle',{timeout:60000});
const metrics=await page.evaluate(()=>({navigation:performance.getEntriesByType('navigation').map(n=>({ttfb:Math.round(n.responseStart),domReady:Math.round(n.domContentLoadedEventEnd),load:Math.round(n.loadEventEnd)})),lcp:Math.round(window.__perf.lcp),longTasks:window.__perf.longTasks,
resources:performance.getEntriesByType('resource').map(r=>({path:new URL(r.name).pathname,ms:Math.round(r.duration),bytes:r.transferSize,decoded:r.decodedBodySize})).sort((a,b)=>b.ms-a.ms).slice(0,12)}));
console.log(JSON.stringify({profile:slow?'simulated-4g-cpu4x':'current-network-mobile-viewport',...metrics}));await context.close();}
}finally{await browser.close();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
