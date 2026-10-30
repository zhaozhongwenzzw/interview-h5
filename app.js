const app = document.querySelector('#app');
const toastElement = document.querySelector('#toast');
const STORAGE_KEY = 'interview-h5.profile.v1';
const QUEUE_KEY = 'interview-h5.review-queue.v1';
const CONTENT_CACHE = 'interview-h5-content-v1';
const banks = new Map();
const answerStates = new Map();
let catalog, currentReader = null, renderTicket = 0, toastTimer, scrollTimer, installPrompt;
let favoriteFilter = '', favoriteSearch = '', storageWarning = false;
const defaults = () => ({schemaVersion:1,favorites:[],reading:{},settings:{fontSize:18,showAnswer:true,theme:'system'}});
let profile = defaults();
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = (name, extra='') => `<svg class="icon ${extra}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const questionKey = (bankId, id) => `${bankId}:${id}`;
const stamp = () => new Date().toISOString();
const idsafe = value => typeof value==='string' && /^[a-zA-Z0-9_-]{1,150}$/.test(value) && !['__proto__','constructor','prototype'].includes(value);
const validDate = value => typeof value==='string' && Number.isFinite(Date.parse(value));

function toast(message) {
  toastElement.textContent=message; toastElement.classList.add('visible');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>toastElement.classList.remove('visible'),3600);
}
function normalizeProfile(value) {
  if (!value || value.schemaVersion!==1 || !Array.isArray(value.favorites) || !value.reading || typeof value.reading!=='object' || Array.isArray(value.reading)) throw new Error('备份格式不正确，或版本不受支持。');
  if(value.favorites.length>20000 || Object.keys(value.reading).length>5000) throw new Error('备份记录过多。');
  const result=defaults(), seen=new Set();
  for(const item of value.favorites) {
    if(!item || !idsafe(item.bankId) || !idsafe(item.questionId) || !validDate(item.createdAt)) throw new Error('收藏记录不完整。');
    const key=questionKey(item.bankId,item.questionId);
    if(!seen.has(key)) {seen.add(key);result.favorites.push({bankId:item.bankId,questionId:item.questionId,createdAt:item.createdAt});}
  }
  for(const [bankId,item] of Object.entries(value.reading)) {
    if(!idsafe(bankId)||!item||!idsafe(item.questionId)||!idsafe(item.sectionId)||!validDate(item.updatedAt)) throw new Error('阅读记录不完整。');
    result.reading[bankId]={questionId:item.questionId,sectionId:item.sectionId,updatedAt:item.updatedAt,scrollY:Number.isFinite(item.scrollY)?Math.max(0,Math.min(item.scrollY,1000000)):0};
  }
  if(value.settings) {
    const s=value.settings;
    if(typeof s!=='object' || ![16,17,18,19,20,21,22].includes(s.fontSize) || typeof s.showAnswer!=='boolean' || !['system','light','dark'].includes(s.theme)) throw new Error('阅读偏好格式不正确。');
    result.settings={fontSize:s.fontSize,showAnswer:s.showAnswer,theme:s.theme};
  }
  return result;
}
try { const stored=localStorage.getItem(STORAGE_KEY); if(stored) profile=normalizeProfile(JSON.parse(stored)); }
catch { storageWarning=true; }
function persist() {
  try {localStorage.setItem(STORAGE_KEY,JSON.stringify(profile));}
  catch {if(!storageWarning){toast('当前浏览器无法保存记录，请及时导出 JSON 备份。');storageWarning=true;}}
}
function applySettings() {
  const {theme,fontSize}=profile.settings;
  if(theme==='system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme=theme;
  document.documentElement.style.setProperty('--answer-size',`${fontSize}px`);
}
applySettings();
function isFavorite(bankId,id) {return profile.favorites.some(f=>f.bankId===bankId&&f.questionId===id);}
function toggleFavorite(bankId,id) {
  const was=isFavorite(bankId,id);
  profile.favorites=was?profile.favorites.filter(f=>!(f.bankId===bankId&&f.questionId===id)):[{bankId,questionId:id,createdAt:stamp()},...profile.favorites];
  persist();
  app.querySelectorAll('[data-favorite]').forEach(button=>{
    if(button.dataset.bank===bankId&&button.dataset.favorite===id){button.classList.toggle('starred',!was);button.setAttribute('aria-pressed',String(!was));button.setAttribute('aria-label',was?'收藏本题':'取消收藏');}
  });
  if(route().page==='favorites') renderFavorites().catch(showError);
  toast(was?'已取消收藏':'已加入收藏');
}
function sourceLink(url,label='查看原文 ↗') {
  try {const u=new URL(url);if(!['http:','https:'].includes(u.protocol))return '';return `<a href="${escapeHtml(u.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;}catch{return '';}
}
function sourceName(bank) {try{return bank.source?.author||new URL(bank.source.url).hostname;}catch{return '原文作者';}}
async function loadJson(path) {
  const response=await fetch(new URL(path,document.baseURI),{cache:'no-cache'});
  if(!response.ok) throw new Error(`文件读取失败（${response.status}）：${path}`);
  return response.json();
}
async function loadBank(id) {
  if(banks.has(id)) return banks.get(id);
  const entry=catalog.categories.find(c=>c.id===id);if(!entry) throw new Error('这份题库尚未加入目录。');
  const dataUrl=new URL(entry.dataPath,document.baseURI);
  if(dataUrl.origin!==location.origin || !dataUrl.pathname.startsWith(new URL('./',document.baseURI).pathname)) throw new Error('题库路径无效。');
  const bank=await loadJson(entry.dataPath);
  if(bank.schemaVersion!==1||bank.id!==id||!Array.isArray(bank.sections)) throw new Error('题库 JSON 格式不正确。');
  bank.questionMap=new Map();
  for(const section of bank.sections) {
    if(!idsafe(section.id)||!Array.isArray(section.questions)) throw new Error('章节结构不正确。');
    for(const question of section.questions) {
      if(!idsafe(question.id)||typeof question.title!=='string'||typeof question.answerHtml!=='string'||bank.questionMap.has(question.id)) throw new Error('题目结构不正确或题目编号重复。');
      bank.questionMap.set(question.id,{...question,bankId:id,sectionId:section.id,sectionTitle:section.title,bankTitle:bank.title});
    }
  }
  banks.set(id,bank);return bank;
}
function route() {
  const [path,query='']=location.hash.replace(/^#\/?/,'').split('?');
  const parts=path.split('/').filter(Boolean).map(p=>{try{return decodeURIComponent(p);}catch{return '';}});
  return {page:parts[0]||'catalog',bankId:parts[1],id:parts[2],params:new URLSearchParams(query)};
}
function urlQuestion(bankId,id,from='') {return `#/question/${encodeURIComponent(bankId)}/${encodeURIComponent(id)}${from?'?from='+from:''}`;}
function go(hash) {if(location.hash===hash) render().catch(showError);else location.hash=hash;}
function navigation(active) {
  return `<nav class="bottom-nav" aria-label="主导航"><div class="bottom-nav-inner">${[['catalog','grid','题库'],['favorites','star','收藏'],['settings','settings','我的']].map(([id,i,label])=>`<a class="nav-item" href="#/${id}" ${active===id?'aria-current="page"':''}>${icon(i)}<span>${label}</span></a>`).join('')}</div></nav>`;
}
function header() {
  return `<header class="appbar"><a class="brand" href="#/catalog" aria-label="题间，返回题库"><span class="brand-symbol">${icon('book')}</span><span class="wordmark">题间</span><span class="brand-caption">面试随身读</span></a><div class="app-actions"><span class="status-dot ${navigator.onLine?'':'offline'}" data-network>${navigator.onLine?'随时读一题':'离线阅读'}</span><a href="#/settings" class="icon-button" aria-label="阅读与数据设置">${icon('settings')}</a></div></header>`;
}
function frame(content,active='catalog') {document.body.classList.remove('reader-mode');app.innerHTML=header()+`<main class="container" id="main-content">${content}</main>`+navigation(active);}
function lastReading() {return Object.entries(profile.reading).filter(([id])=>catalog.categories.some(c=>c.id===id)).sort((a,b)=>Date.parse(b[1].updatedAt)-Date.parse(a[1].updatedAt))[0];}
function renderCatalog() {
  const last=lastReading();
  const entries=catalog.categories.map((entry,index)=>`<a class="category-item" href="#/bank/${entry.id}"><span class="category-index">${String(index+1).padStart(2,'0')}</span><div class="category-copy"><h2 class="category-title">${escapeHtml(entry.title)}</h2><p class="category-desc">${escapeHtml(entry.description||'按章节逐题阅读，慢慢把知识串起来。')}</p><span class="category-meta">${entry.sectionCount} 个章节<span aria-hidden="true">·</span>${entry.questionCount} 道题</span></div><span class="category-enter" aria-label="进入题库">${icon('arrow')}</span></a>`).join('');
  frame(`<div class="page-head"><span class="eyebrow">一题一页 · 随时继续</span><div class="heading-line"><h1>我的题库</h1>${last?`<a class="quiet-button" href="${urlQuestion(last[0],last[1].questionId)}">${icon('clock')}继续阅读</a>`:''}</div><p class="page-intro">选一个分类，开始今天的阅读。</p></div><div class="section-label"><span>全部分类</span><span>${catalog.categories.length} 个题库</span></div><div class="category-list">${entries||'<p class="inline-note">还没有题库，请先导入内容。</p>'}</div><p class="below-note">按原文顺序阅读，重要的题目留到收藏里。</p>`);
}
function intro(html,label) {return html?`<details class="intro-details"><summary>${label}</summary><div class="prose">${sanitizeHtml(html)}</div></details>`:'';}
async function renderBank(r,ticket) {
  const bank=await loadBank(r.bankId);if(ticket!==renderTicket)return;
  frame(`<a class="back-link" href="#/catalog">${icon('left')}全部题库</a><span class="eyebrow">一级分类</span><h1>${escapeHtml(bank.title)}</h1><div class="bank-meta"><span>${bank.sections.length} 个章节</span><span>·</span><span>${bank.questionMap.size} 道题</span><span>·</span>${sourceLink(bank.source?.url,'原文来源 ↗')}</div>${intro(bank.introHtml,'阅读原文导读')}<div class="section-label"><span>选择章节</span><span>原文顺序</span></div><ol class="section-list">${bank.sections.map((s,i)=>`<li><a class="list-row" href="#/section/${bank.id}/${s.id}"><span class="row-index">${String(i+1).padStart(2,'0')}</span><span class="row-content"><span class="row-title">${escapeHtml(s.title)}</span></span><span class="row-end"><span class="row-meta">${s.questions.length} 题</span>${icon('right')}</span></a></li>`).join('')}</ol>`);
  enhanceContent();
}
async function renderSection(r,ticket) {
  const bank=await loadBank(r.bankId);if(ticket!==renderTicket)return;
  const section=bank.sections.find(s=>s.id===r.id);if(!section) throw new Error('没有找到这个章节。');
  const last=profile.reading[bank.id];
  frame(`<a class="back-link" href="#/bank/${bank.id}">${icon('left')}${escapeHtml(bank.title)}</a><span class="eyebrow">二级分类</span><h1>${escapeHtml(section.title)}</h1><p class="page-intro">${section.questions.length} 道题，按原文顺序排列。</p>${intro(section.introHtml,'阅读章节说明')}<div class="filter-row"><label class="search-wrap">${icon('search')}<input class="search-input" type="search" id="question-search" placeholder="搜索本章题目" aria-label="搜索本章题目"></label></div><ol class="question-list">${section.questions.map((q,i)=>`<li data-question-title="${escapeHtml(q.title.toLowerCase())}"><a class="list-row" href="${urlQuestion(bank.id,q.id)}"><span class="row-index">${String(i+1).padStart(2,'0')}</span><span class="row-content"><span class="row-title">${escapeHtml(q.title)}</span>${last?.questionId===q.id?'<span class="row-meta">上次读到这里</span>':''}</span><span class="row-end">${isFavorite(bank.id,q.id)?icon('star','starred'):''}${icon('right')}</span></a></li>`).join('')}</ol><p id="search-empty" class="empty" hidden>没有找到符合的题目</p>`);
  enhanceContent();
}
async function favoriteQuestions() {
  const known=profile.favorites.filter(f=>catalog.categories.some(c=>c.id===f.bankId));
  await Promise.all([...new Set(known.map(f=>f.bankId))].map(loadBank));
  return known.map(f=>banks.get(f.bankId)?.questionMap.get(f.questionId)).filter(Boolean);
}
async function renderFavorites(ticket=renderTicket) {
  const questions=await favoriteQuestions();if(ticket!==renderTicket)return;
  const visible=questions.filter(q=>(!favoriteFilter||q.bankId===favoriteFilter)&&q.title.toLowerCase().includes(favoriteSearch.toLowerCase()));
  frame(`<div class="page-head"><span class="eyebrow">反复看，慢慢记</span><h1>我的收藏</h1><p class="page-intro">${questions.length} 道收藏题。从这里进入，只切换当前收藏列表。</p></div>${questions.length?`<div class="filter-row"><label class="search-wrap">${icon('search')}<input class="search-input" type="search" id="favorite-search" placeholder="搜索收藏题目" aria-label="搜索收藏题目" value="${escapeHtml(favoriteSearch)}"></label><select class="select-field" id="favorite-category" aria-label="筛选收藏分类"><option value="">全部分类</option>${catalog.categories.map(c=>`<option value="${c.id}" ${favoriteFilter===c.id?'selected':''}>${escapeHtml(c.title)}</option>`).join('')}</select></div><div id="favorite-results">${favoriteRows(visible)}</div>`:`<div class="empty">${icon('star')}<h2>值得再看一遍的，放在这里</h2><p>阅读时点一下星标，就能随时回来复习。</p><a class="primary-button" href="#/catalog">去选题 ${icon('arrow')}</a></div>`}${profile.favorites.length>questions.length?'<p class="storage-note">部分收藏所属题库尚未载入目录。记录仍已保留，重新加入对应题库后会恢复显示。</p>':''}`,'favorites');
}
function favoriteRows(questions) {return questions.length?`<ul class="favorite-list">${questions.map(q=>`<li class="favorite-row"><a class="list-row" data-review="${q.id}" data-bank="${q.bankId}" href="${urlQuestion(q.bankId,q.id,'favorites')}"><span class="row-content"><span class="row-title">${escapeHtml(q.title)}</span><span class="row-meta">${escapeHtml(q.bankTitle)} / ${escapeHtml(q.sectionTitle)}</span></span>${icon('right')}</a><button class="icon-button starred" type="button" data-favorite="${q.id}" data-bank="${q.bankId}" aria-pressed="true" aria-label="取消收藏：${escapeHtml(q.title)}">${icon('star')}</button></li>`).join('')}</ul>`:'<div class="empty"><p>没有符合条件的收藏题。</p></div>';}
async function updateFavoriteResults() {
  const questions=await favoriteQuestions();
  const visible=questions.filter(q=>(!favoriteFilter||q.bankId===favoriteFilter)&&q.title.toLowerCase().includes(favoriteSearch.toLowerCase()));
  const target=document.querySelector('#favorite-results');if(target)target.innerHTML=favoriteRows(visible);
}
function readReviewQueue() {try {const a=JSON.parse(sessionStorage.getItem(QUEUE_KEY));return Array.isArray(a)?a.filter(q=>q&&idsafe(q.bankId)&&idsafe(q.id)):[];}catch{return [];}}
async function readerQueue(q,r) {
  if(r.params.get('from')==='favorites') {
    let queue=readReviewQueue();
    if(!queue.some(x=>x.bankId===q.bankId&&x.id===q.id)) queue=(await favoriteQuestions()).map(x=>({bankId:x.bankId,id:x.id}));
    if(!queue.some(x=>x.bankId===q.bankId&&x.id===q.id)) queue.unshift({bankId:q.bankId,id:q.id});
    // A previously unavailable category must not break a saved review sequence.
    const available=await Promise.all(queue.map(async ref=>{try {const b=await loadBank(ref.bankId);return b.questionMap.has(ref.id)?ref:null;}catch{return null;}}));
    return available.filter(Boolean);
  }
  const section=banks.get(q.bankId).sections.find(s=>s.id===q.sectionId);
  return section.questions.map(x=>({bankId:q.bankId,id:x.id}));
}
async function renderReader(r,ticket) {
  const bank=await loadBank(r.bankId),q=bank.questionMap.get(r.id);
  if(!q)throw new Error('没有找到这道题，题库可能已经更新。');
  const queue=await readerQueue(q,r);if(ticket!==renderTicket)return;
  const index=queue.findIndex(x=>x.bankId===q.bankId&&x.id===q.id);
  const from=r.params.get('from')==='favorites'?'favorites':'';
  const old=profile.reading[q.bankId];
  const restoreY=old?.questionId===q.id?old.scrollY:0;
  const open=answerStates.has(questionKey(q.bankId,q.id))?answerStates.get(questionKey(q.bankId,q.id)):profile.settings.showAnswer;
  const favorite=isFavorite(q.bankId,q.id);
  currentReader={bankId:q.bankId,id:q.id,sectionId:q.sectionId,queue,index,from};
  profile.reading[q.bankId]={questionId:q.id,sectionId:q.sectionId,updatedAt:stamp(),scrollY:restoreY};persist();
  document.body.classList.add('reader-mode');
  app.innerHTML=`<header class="reader-bar"><a class="icon-button" href="${from?'#/favorites':`#/section/${q.bankId}/${q.sectionId}`}" aria-label="${from?'返回收藏':'返回题目列表'}">${icon('left')}</a><div class="reader-crumb"><span class="bank">${escapeHtml(q.bankTitle)}</span><span class="section">${escapeHtml(q.sectionTitle)}</span></div><button type="button" class="icon-button ${favorite?'starred':''}" data-favorite="${q.id}" data-bank="${q.bankId}" aria-label="${favorite?'取消收藏':'收藏本题'}" aria-pressed="${favorite}">${icon('star')}</button><a class="icon-button" href="#/settings" aria-label="阅读设置">${icon('settings')}</a></header><main class="reader-container" id="main-content"><div class="reader-question-meta"><span>${from?'收藏复习':'本节阅读'} · ${index+1} / ${queue.length}</span><span>左右滑动切换</span></div><h1>${escapeHtml(q.title)}</h1><div class="answer-controls"><span>完整原文答案</span><button type="button" data-action="answer" aria-expanded="${open}" aria-controls="answer-content">${open?'收起答案':'展开答案'}</button></div><article class="prose" id="answer-content" ${open?'':'hidden'} aria-label="本题答案">${sanitizeHtml(q.answerHtml)}</article><div id="answer-hidden" class="answer-hidden" ${open?'hidden':''}><p>先试着回答，再对照原文。</p><button type="button" class="primary-button" data-action="answer">查看完整答案 ${icon('arrow')}</button></div>${index===queue.length-1?`<div class="end-section"><span>${from?'已到本次收藏列表的最后一题':'已到本章节的最后一题'}</span><a href="${from?'#/favorites':`#/bank/${q.bankId}`}">${from?'返回收藏':'选择其他章节'} ${icon('right')}</a></div>`:''}<footer class="source-footer"><span>内容来源：${escapeHtml(sourceName(bank))}</span>${sourceLink(q.sourceUrl||bank.source?.url)}</footer></main><div class="reader-dock"><div class="dock-progress"><span style="width:${(index+1)/queue.length*100}%"></span></div><nav class="reader-dock-inner" aria-label="切换题目"><button type="button" class="secondary-button" data-step="-1" ${index===0?'disabled':''}>${icon('left')}上一题</button><a class="icon-button" href="#/section/${q.bankId}/${q.sectionId}" aria-label="本章题目列表">${icon('list')}</a><button type="button" class="primary-button" data-step="1" ${index===queue.length-1?'disabled':''}>下一题${icon('right')}</button></nav></div>`;
  document.title=`${q.title} · 题间`;
  enhanceContent();bindSwipe();
  requestAnimationFrame(()=>{if(ticket===renderTicket)window.scrollTo(0,restoreY);});
  if(restoreY>0) {
    const images=[...app.querySelectorAll('article img')];
    for(const image of images) image.loading='eager';
    Promise.all(images.map(img=>img.complete?Promise.resolve():new Promise(resolve=>{img.addEventListener('load',resolve,{once:true});img.addEventListener('error',resolve,{once:true});}))).then(()=>{if(ticket===renderTicket&&Math.abs(window.scrollY-restoreY)<100)window.scrollTo(0,restoreY);});
  }
}
function saveScroll() {
  if(!currentReader)return;
  const r=route();
  // A hash navigation can reset window.scrollY before hashchange fires.
  // Keep the last question's saved position when the URL has already changed.
  if(r.page!=='question'||r.bankId!==currentReader.bankId||r.id!==currentReader.id)return;
  const entry=profile.reading[currentReader.bankId];
  if(entry?.questionId===currentReader.id){entry.scrollY=Math.round(window.scrollY);persist();}
}
function step(delta) {
  if(!currentReader)return;
  const ref=currentReader.queue[currentReader.index+delta];if(!ref)return;
  saveScroll();go(urlQuestion(ref.bankId,ref.id,currentReader.from));
}
function bindSwipe() {
  const main=app.querySelector('.reader-container');let touch;
  main.addEventListener('touchstart',e=>{
    touch=null;
    if(e.touches.length!==1||e.target.closest('button,a,input,select,pre,table,img,.table-wrap')||window.getSelection()?.toString())return;
    const t=e.touches[0];if(t.clientX<24||t.clientX>window.innerWidth-24)return;
    touch={x:t.clientX,y:t.clientY};
  },{passive:true});
  main.addEventListener('touchend',e=>{
    if(!touch)return;const t=e.changedTouches[0],dx=t.clientX-touch.x,dy=t.clientY-touch.y;touch=null;
    if(Math.abs(dx)>75&&Math.abs(dx)>1.8*Math.abs(dy)&&!window.getSelection()?.toString())step(dx<0?1:-1);
  },{passive:true});
  main.addEventListener('touchcancel',()=>touch=null,{passive:true});
}
function sanitizeHtml(html) {
  const doc=new DOMParser().parseFromString(String(html||''),'text/html');
  const allowed=new Set(['P','DIV','SPAN','BR','HR','STRONG','B','EM','I','S','DEL','U','SUP','SUB','UL','OL','LI','PRE','CODE','BLOCKQUOTE','TABLE','THEAD','TBODY','TFOOT','TR','TH','TD','IMG','A','H2','H3','H4','H5','H6','FIGURE','FIGCAPTION','DETAILS','SUMMARY']);
  for(const element of [...doc.body.querySelectorAll('*')]) {
    if(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','LINK','META','FORM','INPUT','BUTTON','SVG','MATH'].includes(element.tagName)){element.remove();continue;}
    if(!allowed.has(element.tagName)){element.replaceWith(...element.childNodes);continue;}
    for(const attribute of [...element.attributes]) {
      const name=attribute.name.toLowerCase(),tag=element.tagName;
      if((tag==='IMG'&&['src','alt','width','height'].includes(name))||(tag==='A'&&['href','title'].includes(name))||(['TD','TH'].includes(tag)&&['colspan','rowspan'].includes(name))||(tag==='OL'&&name==='start')||name==='class')continue;
      element.removeAttribute(name);
    }
    if(element.hasAttribute('class')) element.className=element.className.split(/\s+/).filter(c=>/^(language-[\w-]+|token|comment|keyword|string|number|operator|punctuation|function|class-name|boolean|line-numbers-wrapper)$/.test(c)).join(' ');
    if(element.tagName==='A') {
      try {const u=new URL(element.getAttribute('href')||'',document.baseURI);if(!['https:','http:'].includes(u.protocol))element.removeAttribute('href');else{element.href=u.href;element.target='_blank';element.rel='noopener noreferrer';}}catch{element.removeAttribute('href');}
    }
    if(element.tagName==='IMG') {
      try {const u=new URL(element.getAttribute('src')||'',document.baseURI);if(!['https:','http:'].includes(u.protocol))element.remove();else{element.src=u.href;element.loading='lazy';element.decoding='async';}}catch{element.remove();}
    }
  }
  doc.body.querySelectorAll('.line-numbers-wrapper').forEach(el=>el.remove());
  return doc.body.innerHTML;
}
function enhanceContent() {
  app.querySelectorAll('.prose table').forEach(table=>{if(table.parentElement.classList.contains('table-wrap'))return;const div=document.createElement('div');div.className='table-wrap';div.setAttribute('role','region');div.setAttribute('aria-label','原文表格，可左右滑动');table.before(div);div.append(table);});
  app.querySelectorAll('.prose pre').forEach(pre=>{if(pre.querySelector('.code-copy'))return;const button=document.createElement('button');button.className='code-copy';button.type='button';button.textContent='复制代码';button.dataset.copy='true';pre.prepend(button);});
  app.querySelectorAll('.prose img').forEach(img=>{img.addEventListener('error',()=>{img.classList.add('image-failed');img.alt=`图片暂时无法加载：${img.alt||'原文配图'}`;},{once:true});});
}
function renderSettings() {
  const s=profile.settings;
  frame(`<div class="page-head"><span class="eyebrow">按自己的节奏阅读</span><h1>阅读与数据</h1><p class="page-intro">调整阅读习惯，也把积累好好保存。</p></div><h2 class="settings-heading">阅读偏好</h2><section class="settings-group" aria-label="阅读偏好"><div class="setting-row"><div><div class="setting-name">答案字号</div><div class="setting-help">仅调整答案正文，适合长时间阅读</div></div><div class="stepper"><button type="button" data-font="-1" aria-label="减小字号" ${s.fontSize<=16?'disabled':''}>−</button><span>${s.fontSize}</span><button type="button" data-font="1" aria-label="增大字号" ${s.fontSize>=22?'disabled':''}>＋</button></div></div><label class="setting-row"><span><span class="setting-name">默认展开答案</span><span class="setting-help" style="display:block">关闭后，先自行回忆再查看原文</span></span><input id="show-answer" class="toggle" type="checkbox" ${s.showAnswer?'checked':''}></label><div class="setting-row"><label class="setting-name" for="theme-select">界面外观</label><select id="theme-select" class="select-field">${[['system','跟随系统'],['light','浅色'],['dark','深色']].map(([v,l])=>`<option value="${v}" ${s.theme===v?'selected':''}>${l}</option>`).join('')}</select></div></section><h2 class="settings-heading">记录与备份</h2><section class="settings-group" aria-label="记录与备份"><div class="setting-row"><div><div class="setting-name">收藏与阅读记录</div><div class="setting-help">${profile.favorites.length} 道收藏 · ${Object.keys(profile.reading).length} 份题库阅读记录</div></div><span class="pill">保存在此设备</span></div><div class="backup-content"><p>导出为 JSON 文件备份；导入会合并收藏和阅读记录，不会覆盖题库内容。</p><div class="setting-actions"><button type="button" class="primary-button" data-action="export">${icon('download')}导出备份</button><button type="button" class="secondary-button" data-action="import">导入备份</button></div></div></section><h2 class="settings-heading">离线与桌面</h2><section class="settings-group"><div class="backup-content"><div class="setting-name">把题库放进口袋</div><p style="margin-top:7px">下载当前题库和配图后，断网也能继续读。</p><div class="setting-actions"><button type="button" class="secondary-button" data-action="offline">${icon('download')}保存供离线阅读</button><button type="button" class="secondary-button" data-action="install">添加到桌面</button></div><div class="offline-status" id="offline-progress" role="status" aria-live="polite"></div></div></section><p class="storage-note">个人记录保存在当前浏览器中，建议定期导出备份。更换设备时可导入同一份 JSON。</p><p class="storage-note">题库与配图来自原文，保留原作者署名与来源链接。${catalog.categories.map(c=>sourceLink(c.sourceUrl,escapeHtml(c.title)+' ↗')).join(' · ')}</p><p class="storage-note">题间 · H5 v1.1</p>`,'settings');
}
function showError(error) {
  currentReader=null;document.title='打开失败 · 题间';
  const message=location.protocol==='file:'?'请通过项目里的 Start-H5.cmd 启动本地预览，或把整个文件夹上传到静态服务器。浏览器直接打开文件无法读取 JSON。':error.message||'暂时无法打开，请检查网络后重试。';
  frame(`<div class="error-box"><h1>暂时没能打开</h1><p>${escapeHtml(message)}</p><div class="setting-actions"><button type="button" class="primary-button" data-action="retry">重新加载</button><a class="secondary-button" href="#/catalog">返回题库</a></div></div>`);
}
async function render() {
  const ticket=++renderTicket,r=route();currentReader=null;
  if(r.page!=='question'){window.scrollTo(0,0);document.title='题间 · 面试随身读';}
  switch(r.page) {
    case 'catalog':renderCatalog();break;
    case 'bank':await renderBank(r,ticket);break;
    case 'section':await renderSection(r,ticket);break;
    case 'question':await renderReader(r,ticket);break;
    case 'favorites':await renderFavorites(ticket);break;
    case 'settings':renderSettings();break;
    default:throw new Error('这个页面不存在，请返回题库重新选择。');
  }
}
function exportBackup() {
  saveScroll();
  const file={kind:'interview-h5-backup',schemaVersion:1,exportedAt:stamp(),profile};
  const blob=new Blob([JSON.stringify(file,null,2)],{type:'application/json;charset=utf-8'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`题间备份-${new Date().toISOString().slice(0,10)}.json`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);toast('已导出 JSON 备份');
}
async function importBackup(file) {
  if(!file)return;if(file.size>2*1024*1024)throw new Error('备份文件超过 2 MB，请选择正确的 JSON 文件。');
  const data=JSON.parse(await file.text());
  if(data.kind!=='interview-h5-backup'||data.schemaVersion!==1)throw new Error('这不是题间的备份文件。');
  const incoming=normalizeProfile(data.profile),merged=normalizeProfile(profile);
  for(const favorite of incoming.favorites) if(!merged.favorites.some(f=>f.bankId===favorite.bankId&&f.questionId===favorite.questionId))merged.favorites.push(favorite);
  for(const [id,entry] of Object.entries(incoming.reading)) if(!merged.reading[id]||Date.parse(entry.updatedAt)>Date.parse(merged.reading[id].updatedAt))merged.reading[id]=entry;
  merged.settings=incoming.settings;profile=normalizeProfile(merged);persist();applySettings();answerStates.clear();await render();toast(`备份已合并，现有 ${profile.favorites.length} 道收藏`);
}
async function cacheOffline(button) {
  const progress=document.querySelector('#offline-progress');
  if(!('caches' in window)||!('serviceWorker' in navigator)||!isSecureContext){toast('离线阅读需要 HTTPS，或在本机 localhost 下使用。');return;}
  button.disabled=true;progress.textContent='正在准备题库和图片…';
  try {
    await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('离线服务尚未就绪，请刷新后再试。')),15000))]);
    const data=await Promise.all(catalog.categories.map(c=>loadBank(c.id)));
    const paths=['./','./index.html','./styles.css','./app.js','./manifest.webmanifest','./assets/icon.svg','./assets/icon-192.png','./assets/icon-512.png','./data/catalog.json',...catalog.categories.map(c=>c.dataPath),...data.flatMap(b=>(b.assets||[]).map(a=>a.path))];
    const urls=[...new Set(paths.map(p=>new URL(p,document.baseURI).href))];
    const cache=await caches.open(CONTENT_CACHE);let cursor=0,done=0;const failed=[];
    async function worker() {
      while(cursor<urls.length){const url=urls[cursor++];try{const response=await fetch(url,{cache:'reload'});if(!response.ok)throw new Error();await cache.put(url,response);}catch{failed.push(url);}done++;progress.textContent=`正在保存 ${done} / ${urls.length} 个文件`;}
    }
    await Promise.all([worker(),worker(),worker()]);
    if(failed.length){progress.textContent=`${failed.length} 个文件未能保存，请联网后重试。`;toast('部分文件未下载完成');}
    else {progress.textContent=`已保存 ${data.reduce((n,b)=>n+b.questionMap.size,0)} 道题和 ${data.reduce((n,b)=>n+(b.assets||[]).length,0)} 张配图，可离线阅读。`;localStorage.setItem('interview-h5.offline-at',stamp());toast('题库与配图已保存，可离线阅读');}
  } catch(error) {progress.textContent=`保存失败：${error.message}`;} finally {button.disabled=false;}
}
app.addEventListener('click',async event=>{
  if(event.target.closest('a[href^="#/"]'))saveScroll();
  const favorite=event.target.closest('[data-favorite]');if(favorite){toggleFavorite(favorite.dataset.bank,favorite.dataset.favorite);return;}
  const review=event.target.closest('[data-review]');
  if(review){event.preventDefault();const qs=(await favoriteQuestions()).filter(q=>(!favoriteFilter||q.bankId===favoriteFilter)&&q.title.toLowerCase().includes(favoriteSearch.toLowerCase()));try{sessionStorage.setItem(QUEUE_KEY,JSON.stringify(qs.map(q=>({bankId:q.bankId,id:q.id}))));}catch{}go(review.getAttribute('href'));return;}
  const image=event.target.closest('.prose img');
  if(image){event.preventDefault();const full=document.querySelector('#image-full');full.src=image.src;full.alt=image.alt;document.querySelector('#image-caption').textContent=image.alt||'原文图片';document.querySelector('.image-stage').classList.remove('zoomed');document.querySelector('#image-dialog').showModal();return;}
  const copy=event.target.closest('[data-copy]');
  if(copy){const pre=copy.closest('pre'),clone=pre.cloneNode(true);clone.querySelectorAll('button').forEach(b=>b.remove());try{await navigator.clipboard.writeText(clone.textContent);toast('代码已复制');}catch{toast('复制未成功，可长按选中代码复制。');}return;}
  const font=event.target.closest('[data-font]');
  if(font){profile.settings.fontSize=Math.max(16,Math.min(22,profile.settings.fontSize+Number(font.dataset.font)));persist();applySettings();renderSettings();return;}
  const next=event.target.closest('[data-step]');if(next&&!next.disabled){step(Number(next.dataset.step));return;}
  const button=event.target.closest('[data-action]');if(!button)return;
  try {switch(button.dataset.action) {
    case 'answer':{
      const content=document.querySelector('#answer-content'),open=content.hidden;content.hidden=!open;document.querySelector('#answer-hidden').hidden=open;
      const toggle=app.querySelector('[aria-controls="answer-content"]');toggle.textContent=open?'收起答案':'展开答案';toggle.setAttribute('aria-expanded',String(open));answerStates.set(questionKey(currentReader.bankId,currentReader.id),open);break;
    }
    case 'export':exportBackup();break;
    case 'import':document.querySelector('#backup-file').click();break;
    case 'offline':await cacheOffline(button);break;
    case 'install':if(installPrompt){await installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;}else toast('请打开浏览器菜单，选择“添加到主屏幕”或“安装应用”。');break;
    case 'retry':location.reload();break;
  }}catch(error){toast(error.message);}
});
app.addEventListener('input',event=>{
  if(event.target.id==='question-search') {let count=0;const term=event.target.value.toLowerCase().trim();app.querySelectorAll('[data-question-title]').forEach(row=>{row.hidden=!row.dataset.questionTitle.includes(term);if(!row.hidden)count++;});document.querySelector('#search-empty').hidden=count!==0;}
  if(event.target.id==='favorite-search'){favoriteSearch=event.target.value;updateFavoriteResults().catch(error=>toast(error.message));}
});
app.addEventListener('change',event=>{
  if(event.target.id==='theme-select'){profile.settings.theme=event.target.value;persist();applySettings();}
  if(event.target.id==='show-answer'){profile.settings.showAnswer=event.target.checked;answerStates.clear();persist();}
  if(event.target.id==='favorite-category'){favoriteFilter=event.target.value;updateFavoriteResults().catch(error=>toast(error.message));}
});
document.querySelector('#backup-file').addEventListener('change',event=>{importBackup(event.target.files[0]).catch(error=>toast(`导入失败：${error.message}`)).finally(()=>{event.target.value='';});});
document.querySelector('#image-close').addEventListener('click',()=>document.querySelector('#image-dialog').close());
document.querySelector('#image-zoom').addEventListener('click',()=>document.querySelector('.image-stage').classList.toggle('zoomed'));
document.querySelector('#image-full').addEventListener('click',()=>document.querySelector('.image-stage').classList.toggle('zoomed'));
document.querySelector('#image-dialog').addEventListener('click',event=>{if(event.target===event.currentTarget)event.currentTarget.close();});
window.addEventListener('hashchange',()=>{saveScroll();render().catch(showError);});
window.addEventListener('scroll',()=>{clearTimeout(scrollTimer);scrollTimer=setTimeout(saveScroll,350);},{passive:true});
window.addEventListener('pagehide',saveScroll);
window.addEventListener('storage',event=>{if(event.key===STORAGE_KEY&&event.newValue){try{profile=normalizeProfile(JSON.parse(event.newValue));applySettings();if(!currentReader)render().catch(showError);}catch{}}});
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;});
for(const name of ['online','offline'])window.addEventListener(name,()=>{const status=document.querySelector('[data-network]');if(status){status.textContent=navigator.onLine?'随时读一题':'离线阅读';status.classList.toggle('offline',!navigator.onLine);}});
async function start() {
  catalog=await loadJson('./data/catalog.json');
  if(catalog.schemaVersion!==1||!Array.isArray(catalog.categories)||catalog.categories.some(c=>!idsafe(c.id)||typeof c.dataPath!=='string'))throw new Error('分类索引 JSON 格式不正确。');
  await render();
  if(storageWarning)toast('本地记录未能读取，建议检查备份文件。');
  if('serviceWorker' in navigator&&isSecureContext)navigator.serviceWorker.register('./sw.js',{scope:'./'}).catch(()=>toast('离线功能暂时不可用，在线阅读不受影响。'));
}
start().catch(showError);
