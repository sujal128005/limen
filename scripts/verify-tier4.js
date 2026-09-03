'use strict';

const { launch: launchBrowser } = require('./browser');

/*
 * Tier 4, rendered.
 *
 * The delivery signatures, the payment float, the door's waiting hints, the
 * unread count, the relocated assistant, and contrast in both themes. All of
 * them are questions about what a browser draws, so none of them can be settled
 * by the unit suite.
 *
 *   npm start                 # in one terminal
 *   npm run verify:tier4      # in another
 *
 * Needs a browser, and says so rather than failing, if one is not installed.
 */

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch (_) {
  console.log('\n  verify:tier4 needs Playwright.\n');
  console.log('    npm install --no-save playwright-core\n');
  console.log('  A browser is found separately: scripts/browser.js uses an installed');
  console.log('  Chrome or Edge, or @sparticuz/chromium on Linux.\n');
  console.log('  Skipping, and not counting it as a pass.\n');
  process.exit(0);
}

const BASE = process.env.LIMEN_BASE || 'http://localhost:4000';
const CODES={sales:'2481',head:'7390',finance:'5162'};
const REQ='I need 500 kg of bottle-grade PET resin. Budget is $1,200 total. Delivery within 14 days. Must be FDA food-contact certified.';
let fails=0; const check=(n,ok,d)=>{console.log(`  ${ok?'ok  ':'FAIL'}  ${n}${d?'   '+d:''}`); if(!ok)fails++;};

/*
 * A screenshot is a diagnostic, not a check.
 *
 * One timing out should not abort a verification run and lose every result
 * behind it, which is exactly what happened: sixteen passing checks thrown away
 * because a font took too long to load in a headless browser.
 */
async function shot(page, path) {
  try {
    /*
     * Backdrop filters are turned off for the capture.
     *
     * They are GPU accelerated on real hardware and used throughout the top
     * bar, the status capsule and the panels. Under the software renderer a
     * headless browser uses, rasterising one costs enough that a screenshot
     * never completes, and a diagnostic that hangs is worse than no diagnostic.
     * Nothing about the layout being checked depends on the blur.
     */
    await page.addStyleTag({ content: '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;}' });
    await page.screenshot({ path, timeout: 8000 });
  } catch (e) {
    console.log(`  note  screenshot ${path} skipped: ${e.message.split('\n')[0]}`);
  }
}


/*
 * Freeze motion before a click that has to land.
 *
 * Not a product problem, and worth writing down because I spent a while
 * assuming it was. Playwright will not click until an element reports the same
 * bounding box on two consecutive animation frames. This interface has an
 * ambient background of three large blurred gradients that drift on a 54 second
 * loop. On a GPU that is free. Under the software rasteriser a headless browser
 * falls back to here, compositing those blurs eats the frame budget, requestAnimationFrame
 * is starved, and the stability check times out on a button that measurement
 * confirms has not moved a pixel in four seconds.
 *
 * The tell was that page.screenshot timed out in the same places, which is not
 * something a misplaced button does.
 *
 * So animation is switched off immediately before the desk switch. Nothing
 * being checked here is about motion, and a suite that fails on the renderer
 * rather than the product teaches nothing.
 */
async function stillness(page) {
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;}' });
  await page.waitForTimeout(120);
}


/*
 * Is there a server to check?
 *
 * Without this the first API call fails with "fetch failed", which names
 * nothing and sends people to look at the script. This suite drives a running
 * server on purpose, so the useful message is the one that says to start it.
 */
async function requireServer(base) {
  try {
    const r = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(4000) });
    if (r.ok) return true;
  } catch (_) { /* falls through to the message below */ }
  console.log(`\n  Nothing is listening on ${base}\n`);
  console.log('  This suite drives a running server. Start one in another terminal:\n');
  console.log('    npm start\n');
  console.log('  Then run this again. Set LIMEN_BASE to check a different address.\n');
  return false;
}

(async()=>{
  if (!await requireServer(BASE)) { process.exitCode = 0; return; }
  const ws='t4-'+Date.now().toString(36); const T={};
  for(const r of ['sales','head','finance']){const x=await fetch(BASE+'/api/session/login',{method:'POST',headers:{'content-type':'application/json','x-workspace':ws},body:JSON.stringify({role:r,code:CODES[r]})});T[r]=(await x.json()).token;}
  const post=async(p,role,b)=>{const r=await fetch(BASE+p,{method:'POST',headers:{'content-type':'application/json','x-workspace':ws,authorization:'Bearer '+T[role]},body:JSON.stringify(b||{})});return {s:r.status,j:await r.json().catch(()=>({}))};};
  await post('/api/brief','sales',{text:REQ});
  for(const p of ['/api/candidates','/api/negotiate','/api/recommend','/api/purchase/submit','/api/purchase/send-to-head']) await post(p,'sales');
  for(const p of ['/api/purchase/approve','/api/policy','/api/deal']) await post(p,'head');


  /*
   * This suite needs the payment stand-in, and says so before it starts.
   *
   * It funds the payment float through the gateway sheet, and once Razorpay
   * Checkout is configured a script cannot do that: a live order is paid with a
   * card, by a person, in a browser. The server withholds the stand-in payment
   * in live mode deliberately, because handing one out would let any page skip
   * the gateway and credit itself. That is a property worth having, not a
   * limitation to route around.
   *
   * Checked before the browser starts, rather than discovered later as a Done
   * button that never appears.
   */
  {
    const fl = await (await fetch(BASE + '/api/payments/float', { headers: { 'x-workspace': ws, authorization: 'Bearer ' + T.finance } })).json();
    if (fl && fl.checkout && fl.checkout.live) {
      console.log('\n  Razorpay Checkout is live on this server, so the float cannot be');
      console.log('  funded by a script. Comment out RAZORPAY_KEY_ID and');
      console.log('  RAZORPAY_KEY_SECRET in .env, restart, and run this again.');
      console.log('  Nothing is broken; npm test covers the live path without a card.\n');
    /*
     * exitCode and return, not process.exit.
     *
     * process.exit tears the process down while the fetch above still has a
     * socket closing, and libuv on Windows asserts on that:
     *
     *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
     *   file src\win\async.c, line 76
     *
     * A clean stop that ends in a crash dialog is not a clean stop. Setting the
     * code and returning lets node close its handles and exit on its own.
     */
      process.exitCode = 0;
      return;
    }
  }

  const b = await launchBrowser(chromium);
  if (!b) return;   // resolveBrowser already printed what to install
  const signIn=async(pg,role)=>{
    await pg.addInitScript((w)=>{localStorage.setItem('limen.workspace',w);sessionStorage.removeItem('limen.session');},ws);
    await pg.goto(BASE,{waitUntil:'networkidle'});
    /* The entry screen animates in; clicking the moment the network goes quiet
       lands on a control that is still moving. */
    await pg.waitForTimeout(700);
    await pg.getByRole('button',{name:/demo workspace/i}).first().click();
    await pg.waitForSelector('.door-card');
    return pg;
  };

  console.log('\nThe door shows what is waiting');
  const d=await b.newPage({viewport:{width:1280,height:900}});
  await signIn(d,'sales');
  const doorTxt=await d.locator('.door-card').innerText();
  // The waiting action depends on where the purchase actually is, so the check
  // asks the server what it should say rather than hardcoding one step.
  const expected=(await (await fetch(BASE+'/api/session/roles',{headers:{'x-workspace':ws}})).json()).roles.find(r=>r.waiting);
  check('the door names the desk with work', !!expected && doorTxt.includes(expected.waiting),
    expected?`${expected.id}: ${expected.waiting}`:'nothing waiting');
  check('and marks that desk', (await d.locator('.door-role.has-work').count())>0);
  await shot(d, '/tmp/t4-door.png');

  console.log('\nDelivery needs two signatures');
  await d.getByRole('radio',{name:/Sales/i}).click();
  await d.locator('.door-name input').fill(CODES.sales);
  await d.getByRole('button',{name:/continue as/i}).click();
  await d.waitForSelector('.canvas-inner'); await d.waitForTimeout(2500);
  const rev=(await d.locator('.rail2-item').allInnerTexts()).findIndex(t=>/my purchase/i.test(t));
  await d.locator('.rail2-item').nth(rev).click(); await d.waitForTimeout(1200);
  check('the two signatures are shown', (await d.locator('.delivery').count())>0);
  check('the simulated counterparty is labelled', (await d.locator('.dl-sim').count())>0);
  const dlTxt=await d.locator('.delivery').innerText();
  check('and it does not overclaim', /still settle a deal that never moved/i.test(dlTxt));
  await shot(d, '/tmp/t4-delivery.png');

  console.log('\nMessages are announced, not hidden');
  await post('/api/messages','head',{body:'Can we revisit the lead time?'});
  await d.waitForTimeout(5000);
  const cnt=await d.locator('.rail2-count').count();
  check('the nav shows an unread count', cnt>0, `${cnt} badge`);

  console.log('\nRazorpay float on the finance desk');
  /*
   * Same page, switched desk, rather than a second browser page.
   *
   * Opening a page per role was fragile here and, more to the point, it is not
   * what a person does: they press Switch desk in the top bar. Testing the
   * route people actually take is worth more than testing three parallel ones
   * they do not.
   */
  await stillness(d);
  await d.locator('.tb-who').click();
  await d.waitForSelector('.door-card', { timeout: 20000 });
  await d.getByRole('radio', { name: /Finance/i }).click();
  await d.locator('.door-name input').fill(CODES.finance);
  await d.getByRole('button', { name: /continue as/i }).click();
  await d.waitForSelector('.canvas-inner', { timeout: 25000 });
  await d.waitForTimeout(2000);
  check('switching desks lands on the finance desk', (await d.locator('.rail2-item').first().innerText()).match(/payments/i) !== null,
    await d.locator('.rail2-item').first().innerText());

  check('the float is shown', (await d.locator('.float-card').count()) > 0);
  check('the stated rate is named', /stated rate/i.test(await d.locator('.float-card').innerText()));
  /*
   * Through the gateway sheet, which is the flow a person uses.
   *
   * Paying used to happen on one click. It opens a sheet now that names the
   * amount and the rail before anything is charged, so a test that clicks Add
   * funds and waits for a balance is testing a product that no longer exists.
   */
  const before = await d.locator('.fc-v').innerText();
  await d.getByRole('button', { name: /add funds/i }).click();
  await d.waitForTimeout(900);
  check('the gateway sheet opens first', (await d.locator('.paysheet').count()) > 0);
  check('naming the rail', (await d.locator('.pay-rail').innerText()).length > 0,
    await d.locator('.pay-rail').innerText());
  check('and nothing is charged yet', (await d.locator('.fc-v').innerText()) === before, before);

  await d.locator('.pay-go').click();
  await d.waitForTimeout(2600);
  check('it settles with a drawn confirmation', (await d.locator('.pay-tick').count()) > 0);
  await d.getByRole('button', { name: /^done$/i }).click();
  await d.waitForTimeout(900);

  const after = await d.locator('.fc-v').innerText();
  check('a top-up credits it', before !== after, `${before} -> ${after}`);
  check('and is logged', (await d.locator('.fc-log li').count()) > 0);
  await shot(d, '/tmp/t4-float.png');

  // Back to sales, so the assistant checks below run where they used to.
  await stillness(d);
  await d.locator('.tb-who').click();
  await d.waitForSelector('.door-card', { timeout: 20000 });
  await d.getByRole('radio', { name: /Sales/i }).click();
  await d.locator('.door-name input').fill(CODES.sales);
  await d.getByRole('button', { name: /continue as/i }).click();
  await d.waitForSelector('.canvas-inner', { timeout: 25000 });
  await d.waitForTimeout(1500);

  console.log('\nRationale moved, voice gone');
  const fabBox=await d.locator('.rationale-fab').boundingBox();
  check('the assistant is bottom left', fabBox && fabBox.x < 200, fabBox?`x=${Math.round(fabBox.x)}`:'missing');
  check('no voice control remains', (await d.locator('.gv, .gv-dock').count())===0);
  await d.locator('.rationale-fab').click();
  await d.waitForTimeout(700);
  check('the drawer opens', await d.locator('.rationale.open').isVisible());
  await shot(d, '/tmp/t4-rationale.png');

  console.log('\nContrast, both themes');
  for (const theme of ['light','dark']) {
    await d.evaluate((t)=>window.__setTheme && window.__setTheme(t), theme);
    /*
     * Stop the animation, then measure. Do not wait and hope.
     *
     * Switching themes animates, so getComputedStyle mid-transition returns an
     * interpolated colour: at 600ms this read dark text over a background still
     * most of the way to light and reported a contrast failure that does not
     * exist at rest. Raising the sleep to 1600ms did not fix it either, and
     * what finally made it pass was adding more properties to the same
     * evaluate, which is the signature of a race rather than a duration.
     *
     * So transitions are switched off before anything is read. A measurement
     * that depends on a sleep is a measurement that will lie on a slower
     * machine, and I would rather it be boring than fast.
     */
    await d.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important;}' });
    await d.waitForTimeout(250);
    const bad=await d.evaluate(()=>{
      /*
       * Alpha-correct, or it is not a measurement.
       *
       * Most surfaces here are translucent, so an element's own
       * background-color is rarely the colour behind its text. Walking up and
       * taking the first non-transparent value gets the wrong answer whenever a
       * glass layer sits over a different surface, which in this interface is
       * most of the time.
       *
       * So: composite every ancestor background over the one beneath it, in
       * order, and measure against the result. Elements whose background is a
       * gradient are counted and skipped rather than guessed at, because a
       * wrong pass and a wrong fail are both worse than a known gap.
       */
      const parse=(c)=>{
        const m=(c||'').match(/[\d.]+/g);
        if(!m) return null;
        const [r,g,b,a]=[+m[0],+m[1],+m[2], m[3]===undefined?1:+m[3]];
        return [r,g,b,a];
      };
      const over=(fg,bg)=>{
        const a=fg[3];
        return [fg[0]*a+bg[0]*(1-a), fg[1]*a+bg[1]*(1-a), fg[2]*a+bg[2]*(1-a), 1];
      };
      const lum=(c)=>{
        const [r,g,b]=c.slice(0,3).map(v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4);});
        return .2126*r+.7152*g+.0722*b;
      };
      const bodyBg=parse(getComputedStyle(document.body).backgroundColor)||[255,255,255,1];
      let skipped=0;
      const backdrop=(el)=>{
        const stack=[];
        for(let n=el; n; n=n.parentElement){
          const cs=getComputedStyle(n);
          if(cs.backgroundImage && cs.backgroundImage!=='none') return null; // gradient: cannot compute
          const c=parse(cs.backgroundColor);
          if(c && c[3]>0) stack.push(c);
          if(c && c[3]===1) break;
        }
        let base=[bodyBg[0],bodyBg[1],bodyBg[2],1];
        for(let i=stack.length-1;i>=0;i--) base=over(stack[i],base);
        return base;
      };
      const out=[];
      for(const el of document.querySelectorAll('.canvas-inner *, .rail2-item, .door-card *')){
        if(el.children.length) continue;
        const text=(el.textContent||'').trim();
        if(!text) continue;
        const cs=getComputedStyle(el);
        if(cs.visibility==='hidden'||cs.display==='none'||+cs.opacity===0) continue;
        const fg=parse(cs.color); if(!fg) continue;
        const bg=backdrop(el);
        if(!bg){ skipped++; continue; }
        const composited=fg[3]<1?over(fg,bg):fg;
        const l1=lum(composited), l2=lum(bg);
        const ratio=(Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05);
        const size=parseFloat(cs.fontSize), weight=Number(cs.fontWeight)||400;
        const large=size>=24||(size>=18.66&&weight>=700);
        const need=large?3:4.5;
        if(ratio<need-0.01) out.push({t:text.slice(0,32),ratio:+ratio.toFixed(2),need,size,fg:cs.color,bg:bg.map(v=>Math.round(v)).join(","),cls:el.className,parent:el.parentElement&&el.parentElement.className});
      }
      return {bad:out.slice(0,6),skipped,attr:document.documentElement.getAttribute("data-theme"),bodyBg:getComputedStyle(document.body).backgroundColor,canvasVar:getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim(),ink4Var:getComputedStyle(document.documentElement).getPropertyValue("--ink-4").trim(),ready:document.documentElement.hasAttribute("data-theme-ready")};
    });
    check(`${theme}: every label clears WCAG AA`, bad.bad.length===0,
      bad.bad.length?(`theme=${bad.attr} canvas=${bad.canvasVar} ink4=${bad.ink4Var} body=${bad.bodyBg} `+JSON.stringify(bad.bad[0])):`theme=${bad.attr} body=${bad.bodyBg} skipped=${bad.skipped}`);
  }

  console.log(`\n${fails===0?'all checks passed':fails+' FAILED'}\n`);
  await b.close(); process.exit(fails?1:0);
})().catch(e=>{console.error('crashed:',e.message);process.exit(1);});
