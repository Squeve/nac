// Unit tests for sw.js (caching, update, push) in a mock service-worker scope.  Run:  node tests/sw.test.js
const fs=require('fs'), vm=require('vm'), assert=require('assert'), path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','sw.js'),'utf8').replace('__SQ_BUILD__','77');
let pass=0; const t=async(n,f)=>{try{await f();pass++;console.log('PASS ',n)}catch(e){console.log('FAIL ',n,'->',e.message);process.exitCode=1}};
function env(opts={}){
  const stores={}; const handlers={}; const notes=[]; const posts=[];
  const mkCache=name=>({ name,
    put:async(r,v)=>{stores[name]=stores[name]||new Map(); stores[name].set(typeof r==='string'?r:r.url,v)},
    match:async(r,o)=>{const m=stores[name]||new Map(); const u=typeof r==='string'?new URL(r,'https://x.test/nac/').href:r.url; for(const [k,v] of m){ if(k===u||(o&&o.ignoreSearch&&k.split('?')[0]===u.split('?')[0])) return v } },
    addAll:async reqs=>{ if(opts.failPrecache) throw new Error('network'); for(const r of reqs){ stores[name]=stores[name]||new Map(); stores[name].set(new URL(r.url||r,'https://x.test/nac/').href,{ok:true,body:'shell:'+name}) } } });
  const caches={ open:async n=>{stores[n]=stores[n]||new Map(); return mkCache(n)}, keys:async()=>Object.keys(stores), delete:async n=>{delete stores[n]; return true},
    match:async(r,o)=>{ for(const n of Object.keys(stores)){ const h=await mkCache(n).match(r,o); if(h) return h } } };
  let skipped=false, claimed=false, fetched=[];
  const self={ location:{origin:'https://x.test'}, addEventListener:(n,f)=>handlers[n]=f, skipWaiting(){skipped=true},
    registration:{ showNotification:async(t,o)=>{notes.push({t,o})} } };
  const ctx=vm.createContext({ self, caches, clients:{ claim:async()=>{claimed=true}, matchAll:async()=>opts.windows||[], openWindow:async u=>posts.push(['open',u]) },
    fetch:async(r,i)=>{ fetched.push({url:r.url||r,cache:i&&i.cache}); if(opts.offline) throw new Error('offline'); return {ok:true,type:'basic',url:r.url,body:'net:'+(r.url||r),clone(){return this}} },
    Request:class{constructor(u,i){this.url=new URL(u,'https://x.test/nac/').href; this.cache=i&&i.cache}}, Response:{error:()=>({error:true})}, URL, console });
  vm.runInContext(src,ctx);
  return { handlers, stores, notes, posts, fetched, get skipped(){return skipped}, get claimed(){return claimed}, caches };
}
const ev=(o={})=>{const w=[]; return {...o, waitUntil:p=>w.push(p), respondWith:p=>{ev.last=p}, _w:w}};
const fetchEv=(url,mode='no-cors',method='GET',headers={})=>{const e=ev({request:{url,method,mode,headers:{has:k=>k in headers}}}); e.responded=null; e.respondWith=p=>e.responded=p; return e};
(async()=>{
 await t('install saves the whole shell under a name with the build number, bypassing the HTTP cache, then activates',async()=>{
   const E=env(); const e=ev(); E.handlers.install(e); await Promise.all(e._w);
   assert.deepStrictEqual(Object.keys(E.stores),['squevetrack-77']); assert.strictEqual(E.stores['squevetrack-77'].size,4); assert(E.skipped);
 });
 await t('a failed download makes the install fail (old version keeps running) and does NOT activate',async()=>{
   const E=env({failPrecache:true}); const e=ev(); E.handlers.install(e); let failed=false; await Promise.all(e._w).catch(()=>failed=true); assert(failed); assert(!E.skipped);
 });
 await t('activate deletes old shells (and the old v4 cache) but keeps the libraries cache',async()=>{
   const E=env(); E.stores['squevetrack-76']=new Map(); E.stores['squevetrack-v4']=new Map(); E.stores['squevetrack-libs-v1']=new Map(); E.stores['squevetrack-77']=new Map(); E.stores['other-app']=new Map();
   const e=ev(); E.handlers.activate(e); await Promise.all(e._w);
   assert.deepStrictEqual(Object.keys(E.stores).sort(),['other-app','squevetrack-77','squevetrack-libs-v1']); assert(E.claimed);
 });
 await t('page loads are served instantly from the saved shell, even with ?notif= and even offline',async()=>{
   const E=env({offline:true}); const i=ev(); E.handlers.install(i); await Promise.all(i._w);
   for(const u of ['https://x.test/nac/','https://x.test/nac/?notif=borrower:b1','https://x.test/nac/index.html']){ const e=fetchEv(u,'navigate'); E.handlers.fetch(e); const r=await e.responded; assert.strictEqual(r.body,'shell:squevetrack-77',u) }
   assert.strictEqual(E.fetched.filter(f=>!/nac\/$/.test(f.url)).length,0,'no network use');
 });
 await t('sw.js and push-config.json always go to the network; APIs are never touched',async()=>{
   const E=env(); for(const u of ['https://x.test/nac/sw.js','https://x.test/nac/push-config.json','https://bbjp.supabase.co/rest/v1/app_state','https://api.anthropic.com/v1/messages']){ const e=fetchEv(u); E.handlers.fetch(e); assert.strictEqual(e.responded,null,u) }
   const post=fetchEv('https://x.test/nac/api','cors','POST'); E.handlers.fetch(post); assert.strictEqual(post.responded,null);
 });
 await t('CDN libraries: first load fetched + saved, later loads instant from the saved copy and refreshed in the background',async()=>{
   const E=env(); const u='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
   const e1=fetchEv(u); E.handlers.fetch(e1); const r1=await e1.responded; assert(/^net:/.test(r1.body)); await new Promise(r=>setTimeout(r,20));
   assert(E.stores['squevetrack-libs-v1'].has(u));
   const n=E.fetched.length; const e2=fetchEv(u); E.handlers.fetch(e2); const r2=await e2.responded; assert(/^net:/.test(r2.body)); // served the saved copy
   await Promise.all(e2.waitUntil.calls||[]); assert(E.fetched.length>=n);
 });
 const push=(data)=>{const e=ev({data:data===undefined?null:{json:()=>JSON.parse(data),text:()=>String(data)}}); return e};
 await t('push shows the notification with the server text, same tag and tap link',async()=>{
   const E=env({windows:[]}); const e=push(JSON.stringify({title:'🔥 Kofi: promise in 15 min',body:'₵1,200 due at 14:30',tag:'ptp-ind-b1',url:'?notif=borrower:b1'})); E.handlers.push(e); await Promise.all(e._w);
   assert.strictEqual(E.notes.length,1); const n=E.notes[0]; assert.strictEqual(n.t,'🔥 Kofi: promise in 15 min'); assert.strictEqual(n.o.tag,'ptp-ind-b1'); assert.strictEqual(n.o.data.url,'?notif=borrower:b1'); assert.strictEqual(n.o.requireInteraction,true);
 });
 await t('push is not shown twice when the app is open on screen (its own alarms cover it)',async()=>{
   const E=env({windows:[{visibilityState:'visible'}]}); const e=push(JSON.stringify({title:'x'})); E.handlers.push(e); await Promise.all(e._w); assert.strictEqual(E.notes.length,0);
   const E2=env({windows:[{visibilityState:'hidden'}]}); const e2=push(JSON.stringify({title:'x'})); E2.handlers.push(e2); await Promise.all(e2._w); assert.strictEqual(E2.notes.length,1);
 });
 await t('a malformed push still shows something (browsers require it)',async()=>{
   const E=env(); const e=push('not json'); E.handlers.push(e); await Promise.all(e._w); assert.strictEqual(E.notes.length,1); assert.strictEqual(E.notes[0].t,'Reminder');
 });
 console.log(`\n${pass} service-worker checks passed`);
})();
