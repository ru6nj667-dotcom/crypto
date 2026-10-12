// 雲端監控：在 GitHub Actions 上執行「同一份 index.html 的程式」，有狀況就用 Telegram 通知你。
// 手機關螢幕、放背景都不影響。學習結果、實戰成績、持倉都存在 state/state.json。
import fs from "fs";
import vm from "vm";

const TOKEN = process.env.TG_TOKEN;
const TF = process.env.TF || "1h";
const STATE = "state/state.json";
const realSetTimeout = setTimeout;
const sleep = ms => new Promise(r => realSetTimeout(r, ms));

let st = {};
try { st = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { }
st.ls ??= {}; st.sent ??= {}; st.offset ??= 0; st.posMsg ??= {}; st.equity ??= 1000;
const save = () => { fs.mkdirSync("state", { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(st)); };

async function tg(method, body) {
  if (!TOKEN) { console.log("[TG]", method, JSON.stringify(body).slice(0, 300)); return { ok: true, result: [] }; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return await r.json();
  } catch (e) { console.log("TG error", e.message); return { ok: false, result: [] }; }
}
const send = async text => { if (!st.chat) { console.log("⚠️ 還不知道要傳給誰：請在 Telegram 對機器人傳 /start"); return null; } const r = await tg("sendMessage", { chat_id: st.chat, text }); if (!r.ok) console.log("❌ 傳訊息失敗：", r.description || r); return r; };

// ---- 假的瀏覽器環境，讓網頁程式可以在伺服器上跑 ----
const store = st.ls;
store.scan ??= "80";
globalThis.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
const ctxProxy = () => new Proxy(function () { }, { get: () => ctxProxy(), set: () => true, apply: () => ctxProxy() });
const els = {};
function mkEl(id) {
  const data = { value: id === "eq" ? String(st.equity) : id === "scan" ? store.scan : "", clientWidth: 300, options: { length: 0 }, dataset: { s: "1" }, style: {}, open: false, innerHTML: "", textContent: "", className: "" };
  return new Proxy(data, { get(t, k) { if (k in t) return t[k]; if (typeof k === "symbol") return undefined; return () => ctxProxy(); }, set(t, k, v) { t[k] = v; return true; } });
}
globalThis.document = { getElementById: id => (els[id] ??= mkEl(id)), addEventListener() { }, querySelectorAll: () => [], visibilityState: "hidden", title: "" };
globalThis.window = globalThis;
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
globalThis.devicePixelRatio = 1;
globalThis.addEventListener = () => { };
globalThis.requestAnimationFrame = () => 0;
globalThis.WebSocket = class { constructor() { } close() { } };
globalThis.alert = () => { }; globalThis.confirm = () => true;
globalThis.setInterval = () => 0;

// ---- 處理你在 Telegram 傳的指令 ----
const HELP = `指令：
/long 幣 買入價 投入U 槓桿 [停損]　例：/long ETH 2500 100 3
/short 幣 賣出價 投入U 槓桿 [停損]
/list 看持倉
/close 幣　平倉後移除
/equity 1000　設定本金（算下單金額用）
/status 現在推薦
/report 累積經驗報告
/news 新聞與市場情緒
提醒：大約每 5～15 分鐘檢查一次，停損一定要在交易所掛好。`;
const cmds = [];
if (!TOKEN) console.log("❌ 沒有讀到 TG_TOKEN：請到 Settings → Secrets → Actions 新增，名稱要完全是 TG_TOKEN");
const me = TOKEN ? await tg("getMe", {}) : { ok: false };
if (TOKEN) console.log(me.ok ? `✅ TG_TOKEN 正確，機器人是 @${me.result?.username || "?"}` : `❌ TG_TOKEN 錯誤（${me.description || "無法連線"}）：請到 BotFather 重新複製代碼，再到 GitHub Secrets 更新 TG_TOKEN`);
const up = await tg("getUpdates", { offset: st.offset + 1, timeout: 0 });
console.log(`收到 Telegram 訊息 ${(up.result || []).length} 則；已知聊天室：${st.chat ? "有" : "沒有"}`);
for (const u of up.result || []) {
  st.offset = Math.max(st.offset, u.update_id);
  const m = u.message; if (!m || !m.text) continue;
  if (!st.chat) st.chat = m.chat.id;
  if (m.chat.id !== st.chat) continue; // 只聽你本人
  cmds.push(m.text.trim());
}
for (const t of cmds) if (/^\/equity/i.test(t)) { const v = +t.split(/\s+/)[1]; if (v > 0) { st.equity = v; els.eq && (els.eq.value = String(v)); } }

// ---- 新聞與市場情緒（每小時抓一次）：只用來避開風險 ----
const RISK_KW = [["hack", "駭客"], ["exploit", "漏洞攻擊"], ["drain", "資金被盜"], ["stolen", "被盜"], ["delist", "下架"], ["lawsuit", "訴訟"], ["sues", "被告"], ["sued", "被告"], ["charges", "被起訴"], ["fraud", "詐欺"], ["depeg", "脫鉤"], ["insolven", "無力償付"], ["bankrupt", "破產"], ["halt", "暫停"], ["suspend", "暫停"], ["rug pull", "捲款"], ["scam", "詐騙"], ["investigation", "調查"], ["arrest", "逮捕"], ["outage", "當機"], ["vulnerab", "漏洞"], ["attack", "攻擊"], ["unlock", "大量解鎖"], ["liquidat", "大量爆倉"]];
const NAMES = { BITCOIN: "BTC", ETHEREUM: "ETH", ETHER: "ETH", SOLANA: "SOL", RIPPLE: "XRP", DOGECOIN: "DOGE", CARDANO: "ADA", POLKADOT: "DOT", AVALANCHE: "AVAX", CHAINLINK: "LINK", TRON: "TRX", LITECOIN: "LTC", POLYGON: "POL", TONCOIN: "TON", SHIBA: "SHIB", PEPE: "PEPE", ARBITRUM: "ARB", OPTIMISM: "OP", APTOS: "APT", "SUI ": "SUI", NEAR: "NEAR", UNISWAP: "UNI", AAVE: "AAVE", BNB: "BNB", BINANCE: "BNB", HYPERLIQUID: "HYPE", ETHENA: "ENA", WORLDCOIN: "WLD", CELESTIA: "TIA" };
async function fetchText(url) { try { const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 crypto-notify" } }); return r.ok ? await r.text() : ""; } catch { return ""; } }
async function getNews() {
  const out = { time: Date.now(), fng: null, items: [], delist: [], risk: {} };
  try { const j = JSON.parse(await fetchText("https://api.alternative.me/fng/?limit=1")); const v = +j.data[0].value; out.fng = { value: v, zh: v <= 24 ? "極度恐懼" : v <= 44 ? "恐懼" : v <= 55 ? "中性" : v <= 75 ? "貪婪" : "極度貪婪" }; } catch { }
  for (const [src, url] of [["Cointelegraph", "https://cointelegraph.com/rss"], ["CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"], ["Decrypt", "https://decrypt.co/feed"]]) {
    const x = await fetchText(url);
    for (const m of x.matchAll(/<item[\s\S]*?<\/item>/g)) {
      const it = m[0], g = re => { const r = it.match(re); return r ? r[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : ""; };
      const title = g(/<title>([\s\S]*?)<\/title>/), link = g(/<link>([\s\S]*?)<\/link>/), t = Date.parse(g(/<pubDate>([\s\S]*?)<\/pubDate>/)) || Date.now();
      if (title) out.items.push({ src, title, link, time: t });
    }
  }
  try {
    const j = JSON.parse(await fetchText("https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=15&catalogId=161"));
    for (const a of j.data.catalogs[0].articles) { if (Date.now() - a.releaseDate > 30 * 864e5) continue; for (const m of a.title.matchAll(/\b([A-Z][A-Z0-9]{1,9})\b/g)) if (!["BINANCE", "WILL", "USDT", "THE", "AND", "ON", "SPOT", "MARGIN", "FUTURES", "DELIST", "USD", "USDC", "FDUSD", "TRY", "EUR"].includes(m[1])) out.delist.push(m[1]); }
    out.delist = [...new Set(out.delist)];
  } catch { }
  { const seen = new Set(); out.items = out.items.filter(n => { const k = n.title.toLowerCase().slice(0, 50); if (seen.has(k)) return false; seen.add(k); return true; }); }
  out.items.sort((a, b) => b.time - a.time); out.items = out.items.slice(0, 60);
  return out;
}
st.newsT ??= 0;
if (Date.now() - st.newsT > 50 * 6e4 || !st.news) { const n = await getNews(); if (n.items.length || n.fng) { st.news = n; st.newsT = Date.now(); console.log(`新聞：${n.items.length} 則標題、恐懼貪婪 ${n.fng ? n.fng.value : "?"}、下架公告 ${n.delist.length} 個幣`); } else console.log("新聞：這次抓不到（下次再試）"); }
globalThis.__NEWS = st.news || null;

// ---- 執行網頁程式（index.html 裡的同一份邏輯） ----
const html = fs.readFileSync("index.html", "utf8");
let code = html.match(/<script>([\s\S]*)<\/script>/)[1];
code = code.replace('let tf="1h"', `let tf=${JSON.stringify(TF)}`)
  .replace('"https://api1.binance.com"]', '"https://api1.binance.com","https://api.binance.us"]');
vm.runInThisContext(code, { filename: "index.html" });
const G = s => vm.runInThisContext(s);

let waited = 0;
while (waited < 240000) { await sleep(2000); waited += 2000; if (G("OPT!==null&&!optBusy&&!loading")) break; if (G("COINS.length===0&&!loading") && waited > 30000) break; }
const ok = G("OPT!==null");
console.log(`行情：${G("COINS.length")} 個幣，資料來源 ${G("REST")}，AI 學習${ok ? "完成" : "未完成"}，規則${G("ACTIVE") ? "通過驗證" : "未通過驗證"}`);
if (!ok) {
  const k = "fail|" + new Date().toISOString().slice(0, 13);
  if (!st.sent[k]) { st.sent[k] = Date.now(); await send(`⚠️ 雲端這次連不到行情或學習沒完成（${G('document.getElementById("conn").textContent')}），下次會再試。`); }
  save(); process.exit(0);
}

// 持倉指令
const posCmd = [];
const later = [];
for (const t of cmds) {
  const a = t.split(/\s+/), c0 = (a[0] || "").toLowerCase();
  if (c0 === "/long" || c0 === "/short") {
    const c = (a[1] || "").toUpperCase().replace(/USDT$/, ""), entry = +a[2], mU = +a[3], lev = Math.max(1, +a[4] || 1), us = +a[5] || 0, s = c0 === "/long" ? 1 : -1;
    if (!c || !(entry > 0) || !(mU > 0)) { await send("格式：/long 幣 價格 投入U 槓桿 [停損]，例 /long ETH 2500 100 3"); continue; }
    const r = G(`(()=>{const c=${JSON.stringify(c)},s=${s},entry=${entry};const T=(A[c]&&A[c].atr)||entry*.01,stop=${us}>0?${us}:entry-s*Math.max(1,P.stop)*T,risk=Math.abs(entry-stop);
      if((entry-stop)*s<=0)return "停損方向不對";POS.push({id:Date.now(),c,s,entry,m:${mU},lev:${lev},stop,stop0:stop,tp:entry+s*P.rr*risk,at:Date.now()});savePos();
      return "OK 停損 "+fp(stop)+"、停利 "+fp(entry+s*P.rr*risk)+(A[c]?"":"（這個幣下次檢查才開始抓行情）")})()`);
    posCmd.push(`${c} ${s > 0 ? "做多" : "做空"} 已加入監控：${r}`);
  } else if (c0 === "/close") {
    const c = (a[1] || "").toUpperCase(); G(`POS=POS.filter(p=>p.c!==${JSON.stringify(c)});savePos()`); posCmd.push(`${c} 已移除`);
  } else if (c0 === "/list") {
    posCmd.push(G(`POS.length?POS.map(p=>{const e=evalPos(p);return p.c+" "+(p.s>0?"做多":"做空")+" "+p.lev+"x 買 "+fp(p.entry)+(e.pnl!==undefined?"｜"+(e.pnl>=0?"+":"")+e.pnl.toFixed(2)+" U":"")+"\\n👉 "+e.msg}).join("\\n\\n"):"目前沒有持倉。用 /long 或 /short 加入。"`));
  } else if (c0 === "/status") {
    posCmd.push(G(`(()=>{const r=COINS.map(rankOf).filter(x=>x.stage>=3&&x.qual>0).sort((a,b)=>b.stage-a.stage||b.qual-a.qual||a.dist-b.dist).slice(0,5);
      return (ACTIVE?"目前策略："+pdesc(P):"⛔ "+tf+" 目前沒有規則通過驗證，不給訊號")+"\\n\\n"+(r.length?r.map((x,i)=>(i+1)+". "+x.c+" "+x.q.txt+"\\n"+planTxt(x.c,true)).join("\\n"):"現在沒有接近進場的好機會。")})()`));
  } else if (c0 === "/news" || t === "新聞") {
    later.push("news");
  } else if (c0 === "/report" || t === "報告") {
    later.push("report");
  } else if (c0 === "/start" || c0 === "/help") posCmd.push("✅ 已連上你的監控機器人（週期 " + TF + "）。\n\n" + HELP);
}
for (const t of posCmd) await send(t);

if (st.news) {
  const coins = G("JSON.stringify(COINS.concat(POS.map(p=>p.c)))"), set = new Set(JSON.parse(coins));
  const risk = {};
  for (const n of st.news.items) {
    const T = " " + n.title.toUpperCase().replace(/[^A-Z0-9 ]/g, " ") + " ", cs = new Set();
    for (const c of set) if (c.length >= 3 && T.includes(" " + c + " ")) cs.add(c);
    for (const [k, v] of Object.entries(NAMES)) if (T.includes(" " + k.trim() + " ") && set.has(v)) cs.add(v);
    n.coins = [...cs];
    const hit = RISK_KW.find(([k]) => n.title.toLowerCase().includes(k)); n.risk = hit ? hit[1] : "";
    if (hit) for (const c of n.coins) if (!risk[c] || risk[c].time < n.time) risk[c] = { kw: hit[1] + "（" + n.title.slice(0, 60) + "）", time: n.time, link: n.link };
  }
  st.news.risk = risk; globalThis.__NEWS = st.news; G("NEWS=window.__NEWS;JC.clear()");
  if (!st.newsW || Date.now() - st.newsW > 55 * 6e4) { fs.mkdirSync("data", { recursive: true }); fs.writeFileSync("data/news.json", JSON.stringify(st.news)); st.newsW = Date.now(); }
  st.riskSent ??= {};
  const mine = new Set(JSON.parse(G("JSON.stringify(POS.map(p=>p.c))")));
  for (const [c, r] of Object.entries(risk)) { const k = c + "|" + r.time; if (st.riskSent[k] || Date.now() - r.time > 12 * 36e5) continue; if (mine.has(c) || c === "BTC" || c === "ETH") { st.riskSent[k] = Date.now(); await send(`📰 ${mine.has(c) ? "你的持倉 " : ""}${c} 有負面新聞：${r.kw}\n${r.link}\n${mine.has(c) ? "建議檢查停損是否已掛好，必要時先減倉。" : "大盤幣出事常會拖累其他幣，這段時間進場要更保守。"}`); } }
  for (const c of st.news.delist) { const k = "delist|" + c; if (mine.has(c) && !st.riskSent[k]) { st.riskSent[k] = Date.now(); await send(`🚨 你的持倉 ${c} 出現在幣安下架公告裡，請盡快確認並處理。`); } }
}
if (later.includes("news")) await send(st.news ? `📰 市場情緒：${st.news.fng ? "恐懼貪婪 " + st.news.fng.value + "（" + st.news.fng.zh + "）" : "?"}\n` + (Object.keys(st.news.risk || {}).length ? "⚠️ 有負面新聞的幣：" + Object.entries(st.news.risk).map(([c, r]) => c + " " + r.kw.split("（")[0]).join("、") + "\n" : "") + "\n最新標題：\n" + st.news.items.slice(0, 6).map(n => "• " + n.title).join("\n") : "📰 還沒抓到新聞，下一輪再試。");

// ---- 累積經驗：記下每個訊號，之後用K線算出真實結果，永久保存 ----
st.journal ??= [];
if (!st.journal.length) { try { st.journal = JSON.parse(fs.readFileSync("data/journal.json", "utf8")); console.log(`從 data/journal.json 載入 ${st.journal.length} 筆經驗`); } catch { } }
globalThis.__J = st.journal;
const jr = JSON.parse(G(`JSON.stringify((()=>{const J=globalThis.__J,ms=TFMS[tf],now=Date.now(),have=new Set(J.map(r=>r.c+"|"+r.tf+"|"+r.t+"|"+r.fam));let added=0,done=0;
 COINS.forEach(c=>{const a=A[c];if(!a||!a.sg)return;a.sg.forEach(g=>{if(g.time<now-6*ms)return;const k=c+"|"+tf+"|"+g.time+"|"+P.fam;if(have.has(k))return;have.add(k);
  J.push({c,tf,t:g.time,s:g.s,fam:P.fam,stop:g.stop,rr:P.rr,exit:P.exit,atr:g.atr,htf:P.htf,crowd:P.crowd,f:g.f,btc:btcRel(g.time,g.s),news:newsRisk(c)?1:0,fng:NEWS&&NEWS.fng?NEWS.fng.value:null});added++})});
 const F=.0005,S=.0003;J.forEach(r=>{if(r.R!==undefined||r.tf!==tf)return;const a=A[r.c];if(!a||!a.kk){if(now-r.t>14*864e5){r.R=0;r.out="無資料"}return}
  const k=a.kk,i=k.findIndex(b=>b.t>r.t);if(i<0)return;const e=k[i].o*(1+S*r.s),dist=(e-r.stop)*r.s;if(!(dist>0)){r.R=0;r.out="無效";return}
  const q2=simTrade(k,i,r.s,e,r.stop,r.rr,r.exit||"fixed",r.atr);if(!q2||q2.open)return;const ex=q2.ex*(1-S*r.s);r.R=+(((ex-e)*r.s-e*F*2)/dist).toFixed(3);r.out=q2.out==="停損"?"停損":/停利/.test(q2.out)?"停利":"到期";r.out2=q2.out;done++});
 if(J.length>20000)J.splice(0,J.length-20000);JOURNAL=J;jAnalyze();JC.clear();
 return{added,done,total:J.length,closed:J.filter(r=>r.R!==undefined).length}})())`));
st.journal = globalThis.__J;
console.log(`累積經驗：新增 ${jr.added} 筆訊號、${jr.done} 筆有了結果；總共 ${jr.total} 筆（已有結果 ${jr.closed} 筆）`);
if (!st.lastJW || Date.now() - st.lastJW > 6 * 36e5) { fs.mkdirSync("data", { recursive: true }); fs.writeFileSync("data/journal.json", JSON.stringify(st.journal)); st.lastJW = Date.now(); console.log("已寫入 data/journal.json（會存進 GitHub 專案永久保留）"); }

if (later.includes("report")) await send(G(`(()=>{const S=JSTAT;if(!S||!S.n)return"📚 累積經驗：還在收集中（目前有結果的 0 筆），每個訊號出結果後都會記下來。";
 return "📚 累積經驗（"+tf+"）\\n從 "+hm(S.since)+" 起共 "+S.n+" 筆有結果\\n勝率 "+S.all.win.toFixed(0)+"%・平均每筆 "+f2(S.all.avg)+"\\n\\n"+(S.bad.length||S.badC.length?"已自動避開："+S.bad.map(x=>x[2]+"「"+x[1]+"」").concat(S.badC).join("、"):"目前還沒有足夠證據要避開哪種情況（每種情況至少 30 筆才判斷）。")})()`));

// ---- 自動提醒 ----
G("lastMsg=Date.now();JC.clear()"); // 雲端沒有即時連線：計算前把行情時間標成剛更新，避免被當成斷線而漏掉訊號
const msgs = JSON.parse(G(`JSON.stringify((()=>{const out=[];
 COINS.forEach(c=>{const a=A[c];if(!a)return;const q=judge(c);
  if(q.sig&&!q.weak){const p=planOf(c),v=verdict(c);if(!p||!v||!v.ok)return;out.push({k:"sig|"+tf+"|"+c+"|"+a.lastT,t:"✅ 可以進場："+(q.sig.s.s>0?"做多":"做空")+" "+c+"（"+tf+"，"+v.items.length+" 項檢查全部通過）\\n傳訊時現價 "+fp(p.live)+"\\n進場區間 "+fp(p.lo)+"～"+fp(p.hi)+"\\n⚠️ "+(q.sig.s.s>0?"現價高於 "+fp(p.hi):"現價低於 "+fp(p.lo))+" 就不要追，這筆放掉\\n建議用限價單掛在區間內，同時設好停損停利\\n停損 "+fp(p.stop)+"\\n"+(P.exit==="trail"?"第一目標 "+fp(p.tp)+"（到了不賣：停損移到成本，之後跟著價格移動）":"停利 "+fp(p.tp))+"\\n有效到這根K線收盤（還有 "+closeIn(c)+"）\\n歷史勝率 "+a.bt.win.toFixed(0)+"%・平均 "+f2(a.bt.avg)+"（"+a.bt.n+" 筆）"})}
  else if(ACTIVE&&a.bt&&a.bt.n>=5&&a.bt.avg>0){const p=planOf(c);if(p&&!p.now&&p.inZone)out.push({k:"zone|"+tf+"|"+c+"|"+a.lastT,t:"⏰ "+c+" 進入"+(p.s>0?"做多":"做空")+"預估區 "+fp(p.lo)+"～"+fp(p.hi)+"（"+tf+"）\\nK線 "+closeIn(c)+" 後收盤，收盤符合條件才會變成可以進場。"})}});
 POS.forEach(p=>{const e=evalPos(p);if(e.lv!=="ok"&&e.px)out.push({k:"pos|"+p.id,msg:e.msg,t:"💼 "+p.c+" "+(p.s>0?"做多":"做空")+"："+e.msg+(e.pnl!==undefined?"\\n目前 "+(e.pnl>=0?"+":"")+e.pnl.toFixed(2)+" U（"+e.pct.toFixed(1)+"%）":"")})});
 return out})())`));
for (const m of msgs) {
  if (m.k.startsWith("pos|")) { if (st.posMsg[m.k] === m.msg) continue; st.posMsg[m.k] = m.msg; await send(m.t); continue; }
  if (st.sent[m.k]) continue; st.sent[m.k] = Date.now(); await send(m.t);
}
// AI 換規則或判定失效時通知
const sig = G(`JSON.stringify({g:P.g,a:ACTIVE})`);
if (st.lastRule !== sig) { if (st.lastRule) await send(G(`ACTIVE?"🧠 AI 換了新策略："+pdesc(P):"🧠 AI：${TF} 目前沒有規則通過驗證（或實戰失效），先暫停進場訊號。"`)); st.lastRule = sig; }

const cut = Date.now() - 3 * 864e5;
for (const k in st.sent) if (st.sent[k] < cut) delete st.sent[k];
save();
console.log("done", msgs.length, "alerts considered");
process.exit(0);
