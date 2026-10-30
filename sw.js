const VERSION='interview-h5-shell-v1.1.0';
const CONTENT='interview-h5-content-v1';
const SHELL=['./','./index.html','./styles.css','./app.js','./manifest.webmanifest','./assets/icon.svg','./assets/icon-192.png','./assets/icon-512.png','./data/catalog.json'];
self.addEventListener('install',event=>event.waitUntil(caches.open(VERSION).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('interview-h5-shell-')&&key!==VERSION).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url),scope=new URL(self.registration.scope);
  if(request.method!=='GET'||url.origin!==scope.origin||!url.pathname.startsWith(scope.pathname))return;
  const image=url.pathname.includes('/assets/images/');
  event.respondWith((async()=>{
    if(image){const cached=await caches.match(request);if(cached)return cached;}
    try {
      const response=await fetch(request);
      if(response.ok){const cache=await caches.open(CONTENT);await cache.put(request,response.clone());}
      return response;
    } catch {
      const cached=await caches.match(request);if(cached)return cached;
      if(request.mode==='navigate'){const index=await caches.match(new URL('index.html',scope).href);if(index)return index;}
      return new Response('Offline: this file has not been saved yet.',{status:503,headers:{'Content-Type':'text/plain;charset=utf-8'}});
    }
  })());
});
