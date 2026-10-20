// 雲端監控：在 GitHub Actions 上執行「同一份 index.html 的程式」，有狀況就用 Telegram 通知你。
// 手機關螢幕、放背景都不影響。學習結果、實戰成績、持倉都存在 state/state.json。
// 每次執行會連續盯盤約 45 分鐘：每 1 分鐘更新價格、K線一收盤馬上判斷、Telegram 指令幾秒內回覆。
import fs from "fs";
import vm from "vm";
import { execSync } from "child_process";

const TOKEN = process.env.TG_TOKEN;
const TF = process.env.TF || "1h";
const RUN_MS = (process.env.RUN_MIN !== undefined ? +process.env.RUN_MIN : 45) * 6e4;
const T0 = Date.now();
const STATE = "state/state.json";
const realSetTimeout = setTimeout;
const sleep = ms => new Promise(r => realSetTimeout(r, ms));

let st = {};
try { st = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { }
st.ls ??= {}; st.sent ??= {}; st.offset ??= 0; st.posMsg ??= {}; st.equity ??= 1000;
const save = () => { fs.mkdirSync("state", { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(st)); };
const writeData = (f, o) => { fs.mkdirSync("data", { recursive: true }); fs.writeFileSync("data/" + f, JSON.stringify(o)); };

async function tg(method, body, waitMs = 15000) {
  if (!TOKEN) { if (method !== "getUpdates") console.log("[TG]", method, JSON.stringify(body).slice(0, 300)); return { ok: true, result: [] }; }
  const ac = new AbortController(), to = realSetTimeout(() => ac.abort(), waitMs);
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ac.signal });
    return await r.json();
  } catch (e) { if (method !== "getUpdates") console.log("TG error", e.message); return { ok: false, result: [] }; }
  finally { clearTimeout(to); }
}
const send = async text => { if (!st.chat) { console.log("⚠️ 還不知道要傳給誰：請在 Telegram 對機器人傳 /start"); return null; } const r = await tg("sendMessage", { chat_id: st.chat, text }); if (!r.ok) console.log("❌ 傳訊息失敗：", r.description || r); return r; };

// ---- 假的瀏覽器環境，讓網頁程式可以在伺服器上跑 ----
const store = st.ls;
store.scan = process.env.SCAN || "250"; // 跟網頁一樣掃成交量前 250 名（扣掉沒合約的）
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

const HELP = `指令：
/long 幣 買入價 投入U 槓桿 [停損]　例：/long ETH 2500 100 3
/short 幣 賣出價 投入U 槓桿 [停損]
/list 看持倉
/close 幣　平倉後移除
/equity 1000　設定本金（算下單金額用）
/status 現在推薦（只有 ✅ 才是可以下單）
/report 累積經驗報告
/news 新聞與市場情緒
/ask 幣 [多|空]　🎲 進場前模擬：例 /ask ETH 或 /ask SOL 空
/alive 確認雲端有在跑、為什麼沒訊號
/hourly 4　每 4 小時傳一次結論（1、2、4、8 或 off）
/paper　🤖 看 AI 自己摸索的成績（各策略虛擬 1000 U 排行）；/paper off 關掉開平倉通知
/goal 300 600 30　挑戰賽：本金 300 → 600，30 天（/goal 看進度，/goal off 結束）
提醒：雲端大約每 1 分鐘更新一次價格，K線收盤後 1～2 分鐘內就會通知。停損一定要在交易所掛好。
（網頁上「我的持倉」存在手機裡，雲端看不到；要雲端幫你盯持倉，請用 /long 或 /short 加進來。）`;
if (!TOKEN) console.log("❌ 沒有讀到 TG_TOKEN：請到 Settings → Secrets → Actions 新增，名稱要完全是 TG_TOKEN");
if (TOKEN) { const me = await tg("getMe", {}); console.log(me.ok ? `✅ TG_TOKEN 正確，機器人是 @${me.result?.username || "?"}` : `❌ TG_TOKEN 錯誤（${me.description || "無法連線"}）：請到 BotFather 重新複製代碼，再到 GitHub Secrets 更新 TG_TOKEN`); }

// 讀 Telegram 訊息（waitSec>0 會等新訊息最多這麼久，有訊息立刻回來）
async function pollTG(waitSec) {
  const up = await tg("getUpdates", { offset: st.offset + 1, timeout: waitSec }, (waitSec + 10) * 1000);
  const cmds = [];
  for (const u of up.result || []) {
    st.offset = Math.max(st.offset, u.update_id);
    const m = u.message; if (!m || !m.text) continue;
    if (!st.chat) st.chat = m.chat.id;
    if (m.chat.id !== st.chat) continue; // 只聽你本人
    cmds.push(m.text.trim());
  }
  for (const t of cmds) if (/^\/equity/i.test(t)) { const v = +t.split(/\s+/)[1]; if (v > 0) { st.equity = v; els.eq && (els.eq.value = String(v)); if (st.goal) st.goal.eq = v; } }
  return cmds;
}
const firstCmds = await pollTG(0);
console.log(`收到 Telegram 訊息 ${firstCmds.length} 則；已知聊天室：${st.chat ? "有" : "沒有"}`);

// ---- 新聞與市場情緒（每小時抓一次）：只用來避開風險 ----
const RISK_KW = [["hack", "駭客"], ["exploit", "漏洞攻擊"], ["drain", "資金被盜"], ["stolen", "被盜"], ["delist", "下架"], ["lawsuit", "訴訟"], ["sues", "被告"], ["sued", "被告"], ["charges", "被起訴"], ["fraud", "詐欺"], ["depeg", "脫鉤"], ["insolven", "無力償付"], ["bankrupt", "破產"], ["halt", "暫停"], ["suspend", "暫停"], ["rug pull", "捲款"], ["scam", "詐騙"], ["investigation", "調查"], ["arrest", "逮捕"], ["outage", "當機"], ["vulnerab", "漏洞"], ["attack", "攻擊"], ["unlock", "大量解鎖"], ["liquidat", "大量爆倉"]];
const NAMES = { BITCOIN: "BTC", ETHEREUM: "ETH", ETHER: "ETH", SOLANA: "SOL", RIPPLE: "XRP", DOGECOIN: "DOGE", CARDANO: "ADA", POLKADOT: "DOT", AVALANCHE: "AVAX", CHAINLINK: "LINK", TRON: "TRX", LITECOIN: "LTC", POLYGON: "POL", TONCOIN: "TON", SHIBA: "SHIB", PEPE: "PEPE", ARBITRUM: "ARB", OPTIMISM: "OP", APTOS: "APT", "SUI ": "SUI", NEAR: "NEAR", UNISWAP: "UNI", AAVE: "AAVE", BNB: "BNB", BINANCE: "BNB", HYPERLIQUID: "HYPE", ETHENA: "ENA", WORLDCOIN: "WLD", CELESTIA: "TIA" };
async function fetchText(url) { const ac = new AbortController(), to = realSetTimeout(() => ac.abort(), 20000); try { const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 crypto-notify" }, signal: ac.signal }); return r.ok ? await r.text() : ""; } catch { return ""; } finally { clearTimeout(to); } }
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
async function newsUpdate() {
  if (Date.now() - st.newsT <= 50 * 6e4 && st.news) return false;
  const n = await getNews();
  if (n.items.length || n.fng) { st.news = n; st.newsT = Date.now(); console.log(`新聞：${n.items.length} 則標題、恐懼貪婪 ${n.fng ? n.fng.value : "?"}、下架公告 ${n.delist.length} 個幣`); return true; }
  st.newsT = Date.now() - 40 * 6e4; console.log("新聞：這次抓不到（10 分鐘後再試）"); return false;
}
await newsUpdate();
globalThis.__NEWS = st.news || null;

// ---- 幣安 USDT 永續合約清單（只推薦有合約的幣） ----
async function getFut() {
  try { const j = JSON.parse(await fetchText("https://fapi.binance.com/fapi/v1/exchangeInfo")); const l = j.symbols.filter(x => x.contractType === "PERPETUAL" && x.quoteAsset === "USDT" && x.status === "TRADING").map(x => x.symbol); if (l.length > 50) return { l, src: "幣安合約" }; } catch { }
  try { const j = JSON.parse(await fetchText("https://api.coingecko.com/api/v3/derivatives/exchanges/binance_futures?include_tickers=unexpired")); const l = [...new Set((j.tickers || []).map(t => ({ c: String(t.contract_type || "").toLowerCase(), s: String(t.symbol || ((t.base || "") + (t.target || ""))).toUpperCase().replace(/[^A-Z0-9]/g, "") })).filter(t => t.c === "perpetual" && /USDT$/.test(t.s)).map(t => t.s))]; if (l.length > 50) return { l, src: "CoinGecko（幣安合約）" }; } catch { }
  return null;
}
if (!st.fut) { try { const f = JSON.parse(fs.readFileSync("data/futures.json", "utf8")); if (f.list && f.list.length > 50) st.fut = f; } catch { } }
if (!st.fut || Date.now() - st.fut.time > 6 * 36e5) {
  const f = await getFut();
  if (f) { st.fut = { time: Date.now(), list: f.l, src: f.src }; writeData("futures.json", st.fut); console.log(`合約清單：${f.l.length} 個 USDT 永續合約（來源 ${f.src}），已寫入 data/futures.json`); }
  else console.log("合約清單：這次抓不到" + (st.fut ? "，先用上次的" : "，這次不過濾"));
}
globalThis.__FUTSET = true;
globalThis.__FUT = st.fut && Date.now() - st.fut.time < 7 * 864e5 ? st.fut.list : null;

// ---- 執行網頁程式（index.html 裡的同一份邏輯） ----
const html = fs.readFileSync("index.html", "utf8");
let code = html.match(/<script>([\s\S]*)<\/script>/)[1];
const TFS_TRY = ["1h", "4h", "15m"];
const startTF = TFS_TRY.includes(st.tfBest) ? st.tfBest : TF; // 上次找到比較好的週期就從那個開始
code = code.replace('let tf="1h"', `let tf=${JSON.stringify(startTF)}`)
  .replace('"https://api1.binance.com"]', '"https://api1.binance.com","https://api.binance.us"]');
vm.runInThisContext(code, { filename: "index.html" });
const G = s => vm.runInThisContext(s);

async function waitReady() { let w = 0; while (w < 300000) { await sleep(2000); w += 2000; if (G("OPT!==null&&!optBusy&&!loading")) return true; if (G("COINS.length===0&&!loading") && w > 30000) return false; } return false; }
await waitReady();
let ok = G("OPT!==null");
console.log(`行情：${G("COINS.length")} 個幣，資料來源 ${G("REST")}，AI 學習${ok ? "完成" : "未完成"}，規則${G("ACTIVE") ? "通過驗證" : "未通過驗證"}`);
if (!ok) {
  const k = "fail|" + new Date().toISOString().slice(0, 13);
  if (!st.sent[k]) { st.sent[k] = Date.now(); await send(`⚠️ 雲端這次連不到行情或學習沒完成（${G('document.getElementById("conn").textContent')}），下次會再試。`); }
  save(); process.exit(0);
}

// ---- 自動換週期：這個週期考試沒過，就試 1h／4h／15m，挑考試最好的那個 ----
const tfSum = () => JSON.parse(G(`JSON.stringify((()=>{const O=OPT&&(OPT.ens||OPT.chosen||OPT.best);return{tf,pass:!!ACTIVE,test:O&&O.test?O.test:null,t:O&&O.test?tstat(O.test):-9}})())`));
async function switchTF(t) { G(`tf=${JSON.stringify(t)};load()`); await sleep(500); return await waitReady(); }
st.tfRes ??= {};
{
  const cur = tfSum(); st.tfRes[cur.tf] = { ...cur, at: Date.now() };
  const stale = !st.tfEvalT || Date.now() - st.tfEvalT > 3 * 36e5;
  if (stale || (!cur.pass && Date.now() - (st.tfEvalT || 0) > 50 * 6e4)) {
    for (const t of TFS_TRY) { if (t === cur.tf) continue; if (await switchTF(t)) { const r = tfSum(); st.tfRes[t] = { ...r, at: Date.now() }; } }
    st.tfEvalT = Date.now();
    const cands = TFS_TRY.map(t => st.tfRes[t]).filter(r => r && r.pass).sort((a, b) => b.t - a.t);
    const pick = cands.length ? cands[0].tf : (st.tfRes[TF] ? TF : cur.tf);
    const loaded = G("tf");
    if (pick !== loaded) await switchTF(pick);
    const prev = st.tfBest; st.tfBest = pick;
    console.log("週期比較：" + TFS_TRY.map(t => { const r = st.tfRes[t]; return r ? `${t} ${r.pass ? "通過" : "沒過"}（最後考試 ${r.test ? r.test.n + " 注、平均 " + (r.test.avg >= 0 ? "+" : "") + r.test.avg.toFixed(2) + "R" : "無"}）` : `${t} 沒測到`; }).join("；") + ` → 用 ${pick}`);
    if (prev && prev !== pick && cands.length) await send(`🔁 AI 自動換週期：${prev} 最近考試沒過，改用 ${pick}（最後考試 ${cands[0].test.n} 注、平均 ${(cands[0].test.avg >= 0 ? "+" : "") + cands[0].test.avg.toFixed(2)}R）。之後的訊號都是 ${pick} K線。`);
    if (!cands.length && (!st.allFailT || Date.now() - st.allFailT > 12 * 36e5)) { st.allFailT = Date.now(); await send("⏸ 15m、1h、4h 三種週期最近的考試都沒過：現在市場跟所有學過的方法都不合，先不給訊號。雲端會一直重測，有通過的會自動換過去並通知你。"); }
  }
  ok = G("OPT!==null");
}

// 每分鐘只抓每個幣最新幾根K線；有新K線收盤才重新分析那個幣
G(`globalThis.cloudUpd=async function(){let closed=0;const now=Date.now();
 const one=async c=>{try{const k=D[c];if(!k||!k.length)return;const last=k[k.length-1],gap=Math.ceil((now-last.t)/TFMS[tf])+2,lim=Math.min(300,Math.max(3,gap));
  const r=await getJ(REST+"/api/v3/klines?symbol="+c+"USDT&interval="+tf+"&limit="+lim,2);if(!r||!r.length)return;
  const before=k.filter(x=>!x.open).length,m=new Map(k.map(x=>[x.t,x]));r.forEach(x=>m.set(x[0],{t:x[0],o:+x[1],h:+x[2],l:+x[3],c:+x[4],v:+x[5],ct:x[6]}));
  let arr=[...m.values()].sort((a,b)=>a.t-b.t);arr.forEach(x=>{x.open=x.ct>now});if(arr.length>2100)arr=arr.slice(-2000);D[c]=arr;
  const after=arr.filter(x=>!x.open).length;if(after!==before||!A[c]){A[c]=analyze(arr.filter(x=>!x.open),c);closed++}}catch(e){}};
 if(P.htf&&btcDayDir(now)===0)await loadBtcDay(); // 換日後補抓 BTC 日線，不然大方向會變「不明」而擋掉所有訊號
 await one("BTC"); // 先更新 BTC，其他幣判斷「跟 BTC 同方向」才不會因為 BTC 還沒更新而被誤擋
 await pool(COINS.filter(c=>c!=="BTC"),8,one);
 lastMsg=Date.now();JC.clear();if(closed)learn();return closed}`);

// ---- 挑戰賽 ----
function goalLine(c) { // 回傳這個幣照挑戰該下多少
  if (!st.goal) return "";
  return G(`(()=>{const ch=${JSON.stringify(st.goal)},pl=chPlan(ch);if(!pl)return"";const o=chOrder(${JSON.stringify(c)},ch.eq,pl.best.r);if(!o)return"";
    return "\\n\\n🏁 挑戰賽（現在 "+ch.eq.toFixed(0)+" → "+ch.target+" U）：逐倉 "+o.lev+" 倍、保證金 "+o.margin.toFixed(1)+" U（倉位約 "+o.notional.toFixed(0)+" U）\\n碰停損虧約 "+o.riskU.toFixed(1)+" U、碰停利賺約 "+o.winU.toFixed(1)+" U\\n平倉後傳 /equity 新本金，我再排下一筆"})()`);
}
function goalStatus() {
  const g = st.goal; if (!g) return "還沒有挑戰。傳 /goal 本金 目標 天數，例如 /goal 300 600 30";
  return G(`(()=>{const ch=${JSON.stringify(g)},pl=chPlan(ch),left=Math.max(0,(ch.start+ch.days*864e5-Date.now())/864e5),pct=x=>(x*100).toFixed(0)+"%";
    let t="🏁 挑戰賽："+ch.startEq+" → "+ch.target+" U\\n現在 "+ch.eq.toFixed(2)+" U（"+(ch.eq>=ch.startEq?"+":"")+((ch.eq/ch.startEq-1)*100).toFixed(1)+"%），剩 "+left.toFixed(1)+" 天\\n";
    if(ch.eq>=ch.target)return t+"🎉 達標了！建議先把獲利領出一部分。";
    if(!pl)return t+"AI 現在沒有通過驗證的規則，先不要下單。";const b=pl.best;
    t+="每筆碰停損最多虧本金 "+(b.r*100).toFixed(1)+"%（約 "+(ch.eq*b.r).toFixed(1)+" U），一次只做一筆。\\n照目前規則模擬：期限內達標機率 "+pct(b.hit)+"、中途虧到剩 7 成的機率 "+pct(b.ruin)+"，一般會到 "+b.med.toFixed(0)+" U。";
    if(b.hit<.25)t+="\\n⚠️ 這個目標在這個時間內很難達到，下更大只會更容易爆掉。比較實際："+(isFinite(pl.needDays)?"時間拉長到約 "+Math.ceil(pl.needDays)+" 天，或":"")+"目標改成約 "+b.med.toFixed(0)+" U。";
    return t+"\\n\\n現在任務：等 ✅ 通知，收到才下單。"})()`);
}

// ---- 處理 Telegram 指令 ----
async function handleCmds(cmds) {
  const out = [], later = [];
  for (const t of cmds) {
    const a = t.split(/\s+/), c0 = (a[0] || "").toLowerCase();
    if (c0 === "/long" || c0 === "/short") {
      const c = (a[1] || "").toUpperCase().replace(/USDT$/, ""), entry = +a[2], mU = +a[3], lev = Math.max(1, +a[4] || 1), us = +a[5] || 0, s = c0 === "/long" ? 1 : -1;
      if (!c || !(entry > 0) || !(mU > 0)) { out.push("格式：/long 幣 價格 投入U 槓桿 [停損]，例 /long ETH 2500 100 3"); continue; }
      if (!G(`!!A[${JSON.stringify(c)}]`)) { globalThis.__added = null; G(`addCoin(${JSON.stringify(c)},true).then(r=>globalThis.__added=r)`); for (let i = 0; i < 30 && globalThis.__added === null; i++) await sleep(500); }
      const r = G(`(()=>{const c=${JSON.stringify(c)},s=${s},entry=${entry};const T=(A[c]&&A[c].atr)||entry*.01,stop=${us}>0?${us}:entry-s*Math.max(1,P.stop)*T,risk=Math.abs(entry-stop);
        if((entry-stop)*s<=0)return "停損方向不對";POS.push({id:Date.now(),c,s,entry,m:${mU},lev:${lev},stop,stop0:stop,tp:entry+s*P.rr*risk,at:Date.now()});savePos();
        return "OK 停損 "+fp(stop)+"、停利 "+fp(entry+s*P.rr*risk)+(A[c]?"":"（抓不到這個幣的行情，先記下來）")})()`);
      out.push(`${c} ${s > 0 ? "做多" : "做空"} 已加入監控：${r}`);
    } else if (c0 === "/close") {
      const c = (a[1] || "").toUpperCase(); G(`POS=POS.filter(p=>p.c!==${JSON.stringify(c)});savePos()`); out.push(`${c} 已移除`);
    } else if (c0 === "/list") {
      out.push(G(`POS.length?POS.map(p=>{const e=evalPos(p);return p.c+" "+(p.s>0?"做多":"做空")+" "+p.lev+"x 買 "+fp(p.entry)+(e.pnl!==undefined?"｜"+(e.pnl>=0?"+":"")+e.pnl.toFixed(2)+" U":"")+"\\n👉 "+e.msg}).join("\\n\\n"):"目前沒有持倉。用 /long 或 /short 加入。"`));
    } else if (c0 === "/status") {
      out.push(G(`(()=>{const r=COINS.map(rankOf).filter(x=>x.stage>=3&&x.qual>0).sort((a,b)=>b.stage-a.stage||b.qual-a.qual||a.dist-b.dist).slice(0,5);
        return (ACTIVE?"目前策略："+pdesc(P):"⛔ "+tf+" 目前沒有規則通過驗證，不給訊號")+"\\n\\n"+(r.length?r.map((x,i)=>(i+1)+". "+x.c+" "+x.q.txt+(PC[x.c]?"（🧩 "+FAMZH[PC[x.c].fam]+"）":"")+"\\n"+planTxt(x.c,true)).join("\\n"):"現在沒有接近進場的好機會。")})()`));
    } else if (c0 === "/goal") {
      if (/^off$/i.test(a[1] || "")) { st.goal = null; out.push("🏁 挑戰賽已結束。"); }
      else if (a.length >= 4) { const e = +a[1], tg = +a[2], d = +a[3]; if (e > 0 && tg > e && d > 0) { st.goal = { start: Date.now(), startEq: e, eq: e, target: tg, days: d }; st.equity = e; out.push(goalStatus()); } else out.push("格式：/goal 本金 目標 天數，例 /goal 300 600 30（目標要比本金大）"); }
      else out.push(goalStatus());
    } else if (c0 === "/ask" || c0 === "/sim") {
      const c = (a[1] || "").toUpperCase().replace(/USDT$/, ""), w = /多|long|^l$/i.test(a[2] || "") ? 1 : /空|short|^s$/i.test(a[2] || "") ? -1 : 0;
      if (!c) { out.push("格式：/ask 幣 [多|空]，例：/ask BTC 或 /ask ETH 多"); continue; }
      if (!G(`!!A[${JSON.stringify(c)}]`)) { globalThis.__added = null; G(`addCoin(${JSON.stringify(c)},true).then(r=>globalThis.__added=r)`); for (let i = 0; i < 30 && globalThis.__added === null; i++) await sleep(500); }
      out.push(G(`(()=>{try{return simText(simAsk(${JSON.stringify(c)},${w}),false)}catch(e){return "模擬失敗："+e.message}})()`));
    } else if (c0 === "/paper" || t === "練習") {
      if (/^off$/i.test(a[1] || "")) { st.paperMsgs = false; out.push("🤖 之後練習帳戶開倉平倉不傳通知（每天早晚還是會報告），/paper on 打開。"); }
      else if (/^on$/i.test(a[1] || "")) { st.paperMsgs = true; out.push("🤖 練習帳戶每次開倉平倉都會通知你。"); }
      else out.push(paperSummary());
    } else if (c0 === "/hourly") {
      const v = (a[1] || "").toLowerCase(); st.hourly = v === "off" ? 0 : [1, 2, 4, 8].includes(+v) ? +v : 1;
      out.push(st.hourly ? `🕐 每 ${st.hourly} 小時傳一次「這小時能不能做」的結論。` : "🕐 已關掉每小時結論（✅ 訊號照常通知）。");
    } else if (c0 === "/news" || t === "新聞") {
      later.push("news");
    } else if (c0 === "/report" || t === "報告") {
      later.push("report");
    } else if (c0 === "/start" || c0 === "/help") out.push("✅ 已連上你的監控機器人（現在用 " + G("tf") + " K線，雲端會自動挑考試最好的週期）。\n\n" + HELP);
  }
  for (const t of out) await send(t);
  if (later.includes("news")) await send(st.news ? `📰 市場情緒：${st.news.fng ? "恐懼貪婪 " + st.news.fng.value + "（" + st.news.fng.zh + "）" : "?"}\n` + (Object.keys(st.news.risk || {}).length ? "⚠️ 有負面新聞的幣：" + Object.entries(st.news.risk).map(([c, r]) => c + " " + r.kw.split("（")[0]).join("、") + "\n" : "") + "\n最新標題：\n" + st.news.items.slice(0, 6).map(n => "• " + n.title).join("\n") : "📰 還沒抓到新聞，下一輪再試。");
  if (later.includes("report")) await send(G(`(()=>{const S=JSTAT;if(!S||!S.n)return"📚 累積經驗：還在收集中（目前有結果的 0 筆），每個訊號出結果後都會記下來。";
   return "📚 累積經驗（"+tf+"）\\n從 "+hm(S.since)+" 起共 "+S.n+" 筆有結果\\n勝率 "+S.all.win.toFixed(0)+"%・平均每筆 "+f2(S.all.avg)+"\\n\\n"+(S.bad.length||S.badC.length?"已自動避開："+S.bad.map(x=>x[2]+"「"+x[1]+"」").concat(S.badC).join("、"):"目前還沒有足夠證據要避開哪種情況（每種情況至少 30 筆才判斷）。")})()`));
}

// ---- 新聞風險對應到幣 ----
async function newsRiskScan() {
  if (!st.news) return;
  const set = new Set(JSON.parse(G("JSON.stringify(COINS.concat(POS.map(p=>p.c)))")));
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
  if (!st.newsW || Date.now() - st.newsW > 55 * 6e4) { writeData("news.json", st.news); st.newsW = Date.now(); }
  st.riskSent ??= {};
  const mine = new Set(JSON.parse(G("JSON.stringify(POS.map(p=>p.c))")));
  for (const [c, r] of Object.entries(risk)) { const k = c + "|" + r.time; if (st.riskSent[k] || Date.now() - r.time > 12 * 36e5) continue; if (mine.has(c) || c === "BTC" || c === "ETH") { st.riskSent[k] = Date.now(); await send(`📰 ${mine.has(c) ? "你的持倉 " : ""}${c} 有負面新聞：${r.kw}\n${r.link}\n${mine.has(c) ? "建議檢查停損是否已掛好，必要時先減倉。" : "大盤幣出事常會拖累其他幣，這段時間進場要更保守。"}`); } }
  for (const c of st.news.delist) { const k = "delist|" + c; if (mine.has(c) && !st.riskSent[k]) { st.riskSent[k] = Date.now(); await send(`🚨 你的持倉 ${c} 出現在幣安下架公告裡，請盡快確認並處理。`); } }
}

// ---- 雲端大腦：把學習結果存成 data/model.json，網頁打開時直接用 ----
function modelWrite() {
  const m = JSON.parse(G("JSON.stringify(exportModel())")), sig = JSON.stringify([m.g, m.ext, m.active, m.paused, m.grid ? m.grid.time : 0]);
  if (sig !== st.modelSig || !st.modelW || Date.now() - st.modelW > 55 * 6e4) { writeData("model.json", m); st.modelSig = sig; st.modelW = Date.now(); console.log(`已更新 data/model.json（規則${m.active ? "通過" : "未通過／暫停"}）`); }
}

// ---- 累積經驗：記下每個訊號，之後用K線算出真實結果，永久保存 ----
st.journal ??= [];
if (!st.journal.length) { try { st.journal = JSON.parse(fs.readFileSync("data/journal.json", "utf8")); console.log(`從 data/journal.json 載入 ${st.journal.length} 筆經驗`); } catch { } }
function journalUpdate() {
  globalThis.__J = st.journal;
  const jr = JSON.parse(G(`JSON.stringify((()=>{const J=globalThis.__J,ms=TFMS[tf],now=Date.now(),have=new Set(J.map(r=>r.c+"|"+r.tf+"|"+r.t+"|"+r.fam));let added=0,done=0;
   COINS.forEach(c=>{const a=A[c],q=ruleOf(c);if(!a||!a.sg)return;a.sg.forEach(g=>{if(g.time<now-6*ms)return;const k=c+"|"+tf+"|"+g.time+"|"+q.fam;if(have.has(k))return;have.add(k);
    J.push({c,tf,t:g.time,s:g.s,fam:q.fam,stop:g.stop,rr:q.rr,exit:q.exit,atr:g.atr,htf:q.htf,crowd:q.crowd,pc:PC[c]?1:0,f:g.f,btc:btcRel(g.time,g.s),news:newsRisk(c)?1:0,fng:NEWS&&NEWS.fng?NEWS.fng.value:null});added++})});
   const F=.0005,S=.0003;J.forEach(r=>{if(r.R!==undefined||r.tf!==tf)return;const a=A[r.c];if(!a||!a.kk){if(now-r.t>14*864e5){r.R=0;r.out="無資料"}return}
    const k=a.kk,i=k.findIndex(b=>b.t>r.t);if(i<0)return;const e=k[i].o*(1+S*r.s),dist=(e-r.stop)*r.s;if(!(dist>0)){r.R=0;r.out="無效";return}
    const q2=simTrade(k,i,r.s,e,r.stop,r.rr,r.exit||"fixed",r.atr);if(!q2||q2.open)return;const ex=q2.ex*(1-S*r.s);r.R=+(((ex-e)*r.s-e*F*2)/dist).toFixed(3);r.out=q2.out==="停損"?"停損":/停利/.test(q2.out)?"停利":"到期";r.out2=q2.out;done++});
   if(J.length>20000)J.splice(0,J.length-20000);JOURNAL=J;jAnalyze();JC.clear();
   return{added,done,total:J.length,closed:J.filter(r=>r.R!==undefined).length}})())`));
  st.journal = globalThis.__J;
  if (jr.added || jr.done || !st.jLogged) { console.log(`累積經驗：新增 ${jr.added} 筆訊號、${jr.done} 筆有了結果；總共 ${jr.total} 筆（已有結果 ${jr.closed} 筆）`); st.jLogged = 1; }
  if (!st.lastJW || Date.now() - st.lastJW > 40 * 6e4) { writeData("journal.json", st.journal); st.lastJW = Date.now(); console.log("已寫入 data/journal.json（會存進 GitHub 專案永久保留）"); }
}

// ---- 自動提醒 ----
async function alerts() {
  G("lastMsg=Date.now();JC.clear()"); // 雲端沒有即時連線：計算前把行情時間標成剛更新
  const msgs = JSON.parse(G(`JSON.stringify((()=>{const out=[];
   COINS.forEach(c=>{const a=A[c];if(!a)return;const q=judge(c);
    if(q.sig&&!q.weak){const p=planOf(c),v=verdict(c);if(!p||!v||!v.ok)return;out.push({c,k:"sig|"+tf+"|"+c+"|"+a.lastT,t:"✅ 可以進場："+(q.sig.s.s>0?"做多":"做空")+" "+c+"（"+tf+"，"+FAMZH[ruleOf(c).fam]+"，"+v.items.length+" 項檢查全部通過）\\n傳訊時現價 "+fp(p.live)+"\\n進場區間 "+fp(p.lo)+"～"+fp(p.hi)+"\\n⚠️ "+(q.sig.s.s>0?"現價高於 "+fp(p.hi):"現價低於 "+fp(p.lo))+" 就不要追，這筆放掉\\n建議用限價單掛在區間內，同時設好停損停利\\n停損 "+fp(p.stop)+"\\n"+(P.exit==="trail"?"第一目標 "+fp(p.tp)+"（到了不賣：停損移到成本，之後跟著價格移動）":"停利 "+fp(p.tp))+"\\n有效到這根K線收盤（還有 "+closeIn(c)+"）\\n歷史勝率 "+a.bt.win.toFixed(0)+"%・平均 "+f2(a.bt.avg)+"（"+a.bt.n+" 筆）"})}
    });  // 「進入預估區」的預告已取消：只有收盤確認後的 ✅ 才通知，避免提前進場
   POS.forEach(p=>{const e=evalPos(p);if(e.lv!=="ok"&&e.px)out.push({k:"pos|"+p.id,msg:e.msg,t:"💼 "+p.c+" "+(p.s>0?"做多":"做空")+"："+e.msg+(e.pnl!==undefined?"\\n目前 "+(e.pnl>=0?"+":"")+e.pnl.toFixed(2)+" U（"+e.pct.toFixed(1)+"%）":"")})});
   out.forEach(m=>{if(m.c){const n=futNote(m.c);if(n)m.t+="\\n"+n}});
   return out})())`));
  for (const m of msgs) if (m.k.startsWith("sig|") && st.goal) m.t += goalLine(m.c);
  let n = 0;
  for (const m of msgs) {
    if (m.k.startsWith("pos|")) { if (st.posMsg[m.k] === m.msg) continue; st.posMsg[m.k] = m.msg; await send(m.t); n++; continue; }
    if (st.sent[m.k]) continue; st.sent[m.k] = Date.now(); await send(m.t); n++;
    if (m.k.startsWith("sig|")) console.log("📣 送出進場訊號：" + m.c);
  }
  // AI 換規則或判定失效時通知
  const sig = G(`JSON.stringify({g:P.g,a:ACTIVE})`);
  if (st.lastRule !== sig) { if (st.lastRule) await send(G(`ACTIVE?"🧠 AI 換了新策略："+pdesc(P):"🧠 AI："+tf+" 目前沒有規則通過驗證（或實戰失效），先暫停進場訊號。"`)); st.lastRule = sig; }
  const cut = Date.now() - 3 * 864e5;
  for (const k in st.sent) if (st.sent[k] < cut) delete st.sent[k];
  return n;
}


// ---- 每天 09:00、21:00 回報一次「我還活著」：讓你知道雲端有在跑、為什麼沒訊號 ----
async function heartbeat(force) {
  const d = new Date(), h = d.getHours(); if (!force && h < 9) return;
  const slot = d.toLocaleDateString("sv") + (h >= 21 ? "b" : "a"); if (!force && st.hb === slot) return;
  const now = Date.now(), n12 = (st.journal || []).filter(r => r.t > now - 12 * 36e5).length;
  const txt = G(`(()=>{const dz=x=>x>0?"向上":x<0?"向下":"不明",b1=A.BTC&&A.BTC.tdir?A.BTC.tdir.get(A.BTC.lastT):0,bd=btcDayDir(Date.now()),S=JSTAT;
    return "🫀 雲端正常運作中：每 1 分鐘看一次 "+COINS.length+" 個幣，每 15 分鐘重新學習。\\n\\n"
    +"目前規則："+pdesc(P)+(ACTIVE?"（通過驗證）":"（沒通過驗證，暫停給訊號）")+"\\n"
    +(Object.keys(PC).length?"🧩 另外 "+Object.keys(PC).length+" 個幣改用比較適合它的策略\\n":"")
    +"\\nBTC 短線（1 小時）："+dz(b1||0)+"\\nBTC 大方向（日線 200 日均線）："+dz(bd)+"\\n"
    +((P.btc||P.htf)&&b1&&bd&&b1!==bd?"⚠️ 短線跟大方向相反：規則規定這時候多空都不做，所以訊號會很少——這是在保護你，不是壞掉。\\n":"")
    +"\\n過去 12 小時出現訊號：${n12} 個（只有 ✅ 會通知你）\\n"
    +(S&&S.n?"累積經驗："+S.n+" 筆有結果，勝率 "+S.all.win.toFixed(0)+"%、平均 "+f2(S.all.avg):"累積經驗：還在收集中")})()`);
  st.hb = slot; await send(txt); await send(paperSummary());
}
// ---- 每小時結論：這小時能不能做、做什麼 ----
st.hourly ??= 1;
async function hourly(sentSig) {
  if (!st.hourly) return; const d = new Date(); if (d.getMinutes() < 2 || d.getMinutes() > 20) return;
  const slot = Math.floor(Date.now() / 36e5); if (slot % st.hourly) return; if (st.hrSlot === slot) return; st.hrSlot = slot;
  const txt = G(`(()=>{const dz=x=>x>0?"向上":x<0?"向下":"不明",b1=A.BTC&&A.BTC.tdir?A.BTC.tdir.get(A.BTC.lastT)||0:0,bd=btcDayDir(Date.now()),h=new Date().getHours();
    const ok=COINS.filter(c=>{const v=verdict(c);return v&&v.ok}).map(rankOf).sort((a,b)=>b.qual-a.qual);
    let t="🕐 "+h+":00 這小時的結論\\n";
    if(ok.length)return t+"✅ 可以做："+ok.slice(0,3).map(x=>(x.d>0?"做多 ":"做空 ")+x.c).join("、")+"\\n詳細下單方式看上面的 ✅ 通知，或打開網頁的挑戰賽。";
    t+="⏸ 這小時不要做。\\n原因：";
    if(!ACTIVE)t+="AI 現在的規則沒通過驗證（或實戰表現太差暫停中）。";
    else if(!liveGuard().ok){const g=liveGuard();t+="最近 "+g.n+" 筆實際訊號只賺 "+g.win+" 筆、平均 "+f2(g.avg)+"，市場跟規則不合，保護機制先暫停，等表現回來再給訊號。"}
    else if((P.btc||P.htf)&&b1&&bd&&b1!==bd)t+="BTC 短線"+dz(b1)+"、大方向"+dz(bd)+"，兩個相反，規則規定這時候多空都不做。";
    else t+="沒有幣剛好在這根K線收盤時符合條件（BTC 短線"+dz(b1)+"、大方向"+dz(bd)+"）。";
    const w=COINS.map(rankOf).filter(x=>x.d!==0&&x.qual>0&&x.stage>=1).sort((a,b)=>b.stage-a.stage||a.dist-b.dist).slice(0,2);
    if(w.length)t+="\\n\\n最接近的（還不能買）：\\n"+w.map(x=>"・"+x.c+" "+(x.d>0?"做多":"做空")+"方向，"+x.q.txt).join("\\n");
    return t})()`);
  await send(txt);
}

// ---- 🤖 AI 自己摸索：同時跑好幾種策略，各用一個虛擬 1000 U 帳戶，用真實即時價格買賣；總帳戶跟著實戰成績最好的那種做（不碰你的幣安帳戶）----
const PAPER_FEE = 0.0008; // 每邊：手續費 0.05% ＋ 滑價 0.03%
const BOOKS = {
  main: "🤖 總帳戶（跟著目前實戰最好的策略做）",
  rule: "✅ AI 規則訊號",
  sim: "🎲 相似行情模擬",
  mom: "🚀 動能突破（創 50 根新高放量追多／新低追空）",
  rev: "🔄 極端反轉（偏離平均 3 個標準差就反著做）",
  btc: "₿ BTC 跟趨勢（只做 BTC，順著 1h 大方向）",
  rand: "🎰 隨機亂買（對照組：拿來比，看其他方法是不是比亂買好）",
};
st.books ??= {};
if (st.paper && !st.books.main) { st.books.main = st.paper; } // 舊的練習帳戶接到總帳戶
for (const k of Object.keys(BOOKS)) st.books[k] ??= { start: Date.now(), eq0: 1000, eq: 1000, pos: [], log: [], scanT: 0, peak: 1000 };
function paperPx(c) { return G(`(()=>{const k=D[${JSON.stringify(c)}];return k&&k.length?k[k.length-1].c:null})()`); }
function bookStat(b) { const L = b.log.filter(x => isFinite(x.R)), n = L.length, avg = n ? L.reduce((a, x) => a + x.R, 0) / n : 0; return { n, avg, win: n ? L.filter(x => x.pnl > 0).length / n : 0, score: n >= 10 ? avg * Math.sqrt(n) : -9 }; }
function bestBook() { let best = null; for (const k of Object.keys(BOOKS)) { if (k === "main" || k === "rand") continue; const s = bookStat(st.books[k]); if (s.n >= 10 && s.avg > 0.1 && (!best || s.score > best.s.score)) best = { k, s }; } return best; }
const VARIANTS = {
  mom: [{ n: 50, vol: 1.5, m: 2, rr: 2 }, { n: 20, vol: 2, m: 1.5, rr: 3 }, { n: 50, vol: 1.2, m: 3, rr: 1.5 }],
  rev: [{ z: 3, m: 1.5, rr: 1.5 }, { z: 2.5, m: 2, rr: 1 }, { z: 3.5, m: 1, rr: 2 }],
  btc: [{ m: 3, rr: 3 }, { m: 2, rr: 2 }, { m: 4, rr: 2 }],
};
const vDesc = (k, v) => !v ? "" : k === "mom" ? `${v.n} 根新高低、量 ${v.vol} 倍、停損 ${v.m} ATR、停利 ${v.rr}R` : k === "rev" ? `偏離 ${v.z} 個標準差、停損 ${v.m} ATR、停利 ${v.rr}R` : `停損 ${v.m} ATR、停利 ${v.rr}R`;
function candsFor(key, held) {
  const V = JSON.stringify(VARIANTS[key] ? VARIANTS[key][st.books[key] ? (st.books[key].vi || 0) : 0] : {});
  const H = JSON.stringify(held);
  const mk = `const mk=(c,s,how,m,rr)=>{const a=A[c],k=D[c];if(!a||!k||!k.length||!a.atr)return null;const e=k[k.length-1].c,T=a.atr;return{c,s,e,stop:e-s*m*T,tp:e+s*rr*m*T,how,score:0}};`;
  const code = {
    rule: `${mk}const o=[];COINS.forEach(c=>{if(H.includes(c))return;const v=verdict(c);if(v&&v.ok){const p=planOf(c);if(p)o.push({c,s:p.s,e:p.live,stop:p.stop,tp:p.tp,how:"✅ AI 規則訊號（"+FAMZH[ruleOf(c).fam]+"）",score:9})}});return o;`,
    sim: `const o=[];COINS.slice(0,30).forEach(c=>{if(H.includes(c))return;let r;try{r=simAsk(c,0)}catch(e){return}if(!r||!r.ok)return;o.push({c,s:r.plan.s,e:r.plan.e,stop:r.plan.stop,tp:r.plan.tp,how:"🎲 相似行情模擬（驗證平均 "+f2(r.best.neu.avg)+"）",score:r.best.neu.avg})});return o.sort((a,b)=>b.score-a.score);`,
    mom: `${mk}const V=${V},o=[];COINS.slice(0,80).forEach(c=>{if(H.includes(c))return;const a=A[c];if(!a||!a.B)return;const n=a.n,R=a.B.R[V.n],x=a.kk[n-1],av=a.B.R[20].av[n-1];if(!R||!(av>0))return;if(x.c>R.hh[n-1]&&x.v>V.vol*av)o.push(mk(c,1,"🚀 動能突破：創 "+V.n+" 根新高、量放大",V.m,V.rr));else if(x.c<R.ll[n-1]&&x.v>V.vol*av)o.push(mk(c,-1,"🚀 動能突破：創 "+V.n+" 根新低、量放大",V.m,V.rr))});return o.filter(Boolean);`,
    rev: `${mk}const V=${V},o=[];COINS.slice(0,80).forEach(c=>{if(H.includes(c))return;const a=A[c];if(!a||!a.B)return;const z=a.B.z[a.n-1];if(z<-V.z)o.push(mk(c,1,"🔄 極端反轉：跌到平均下 "+(-z).toFixed(1)+" 個標準差",V.m,V.rr));else if(z>V.z)o.push(mk(c,-1,"🔄 極端反轉：漲到平均上 "+z.toFixed(1)+" 個標準差",V.m,V.rr))});return o.filter(Boolean);`,
    btc: `${mk}if(H.includes("BTC"))return[];const a=A.BTC;if(!a||!a.B)return[];const d=a.B.tdir.get(a.lastT)||0;const V=${V};return d?[mk("BTC",d,"₿ BTC 跟趨勢："+(d>0?"1h 大方向向上":"1h 大方向向下"),V.m,V.rr)].filter(Boolean):[];`,
    force: `${mk}const o=[];COINS.slice(0,40).forEach(c=>{if(H.includes(c))return;const k=D[c];if(!k||k.length<30)return;const r=k[k.length-1].c/k[k.length-25].c-1;if(isFinite(r))o.push({r,c})});o.sort((a,b)=>Math.abs(b.r)-Math.abs(a.r));return o.slice(0,6).map(x=>mk(x.c,x.r>0?1:-1,"💪 強迫練習：最近 24 根K線"+(x.r>0?"漲":"跌")+" "+(Math.abs(x.r)*100).toFixed(1)+"%，順著走",1.5,2)).filter(Boolean);`,
    rand: `${mk}if(Math.random()>.3)return[];const L=COINS.slice(0,50).filter(c=>!H.includes(c));if(!L.length)return[];const c=L[Math.floor(Math.random()*L.length)];return[mk(c,Math.random()<.5?1:-1,"🎰 隨機亂買（對照組）",1.5,2)].filter(Boolean);`,
  }[key];
  try { return JSON.parse(G(`JSON.stringify((()=>{const H=${H};${code}})())`)); } catch (e) { console.log("策略 " + key + " 出錯：" + e.message); return []; }
}
async function bookTick(key, follow) {
  const b = st.books[key], now = Date.now(), msgs = [], loud = key === "main" && st.paperMsgs !== false;
  for (const p of b.pos.slice()) {
    const px = paperPx(p.c); if (!px) continue;
    const hitSL = p.s > 0 ? px <= p.stop : px >= p.stop, hitTP = p.s > 0 ? px >= p.tp : px <= p.tp, old = now - p.t > 48 * (p.tfms || 36e5);
    if (!hitSL && !hitTP && !old) continue;
    const ex = px * (1 - p.s * PAPER_FEE), pnl = p.notional * ((ex - p.entry) / p.entry) * p.s, why = hitSL ? "停損" : hitTP ? "停利" : "時間到";
    b.eq += pnl; b.pos = b.pos.filter(x => x !== p);
    b.log.push({ c: p.c, s: p.s, t: p.t, end: now, entry: p.entry, exit: ex, pnl, why, how: p.how, R: pnl / p.riskU });
    if (loud) msgs.push(`🤖 總帳戶平倉：${p.s > 0 ? "做多" : "做空"} ${p.c}（${why}）${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} U → 帳戶 ${b.eq.toFixed(2)} U`);
  }
  b.peak = Math.max(b.peak || b.eq0, b.eq);
  // 撞牆就改方法：這個參數做了 10 筆以上、平均每筆虧超過 0.2R，就換下一組參數重新摸索
  if (VARIANTS[key]) { b.vi ??= 0; b.vStart ??= b.start; b.changes ??= [];
    const L = b.log.filter(x => x.end >= b.vStart), n = L.length, avg = n ? L.reduce((a, x) => a + x.R, 0) / n : 0;
    if (n >= 10 && avg < -0.2) { const from = vDesc(key, VARIANTS[key][b.vi]); b.vi = (b.vi + 1) % VARIANTS[key].length; b.vStart = now; const to = vDesc(key, VARIANTS[key][b.vi]);
      b.changes.push({ t: now, from, to, why: `${n} 筆平均 ${avg.toFixed(2)}R` }); console.log(`🔧 ${BOOKS[key].split("（")[0]} 撞牆（${n} 筆平均 ${avg.toFixed(2)}R），改成：${to}`); } }
  const lastT = G("A.BTC&&A.BTC.lastT||0");
  const mustTrade = key === "main" && b.pos.length === 0 && b.eq > b.eq0 * 0.3 && now - (b.forceT || 0) > 5 * 6e4; if (mustTrade) b.forceT = now; // 總帳戶一定要有單在跑：空手就馬上找一個進場練習
  if (lastT && (lastT !== b.scanT || mustTrade)) { // 每根K線收盤都掃一次（滿倉也掃，讓你看到它在看哪些）
    b.scanT = lastT;
    const held = b.pos.map(p => p.c).concat(b.log.filter(x => now - x.end < 6 * 36e5).map(x => x.c));
    let cands = [];
    if (key === "main") { cands = follow ? candsFor(follow, held).map(x => ({ ...x, how: x.how + "〔總帳戶跟著這個策略〕" })) : candsFor("rule", held).concat(candsFor("sim", held)); }
    else cands = candsFor(key, held);
    if (key === "main" && b.pos.length === 0 && !cands.length) cands = ["mom", "rev", "btc", "force"].flatMap(k => candsFor(k, held)); // 沒有好機會也要做：動能→反轉→BTC→最強勢的幣
    b.watch = cands.slice(0, 6).map(x => ({ c: x.c, s: x.s, how: x.how, e: x.e })); b.watchT = now;
    for (const x of (b.eq > b.eq0 * (key === "main" ? 0.3 : 0.5) ? cands : [])) {
      if (b.pos.length >= 3) break;
      if (b.pos.filter(p => p.s === x.s).length >= 2) continue;
      const stopPct = Math.abs(x.e - x.stop) / x.e; if (!(stopPct > 0.002)) continue;
      const RISK = key === "main" ? 0.02 : 0.01, MAXLEV = key === "main" ? 10 : 3; // 總帳戶：每筆最多賠 2%、最高 10 倍槓桿
      let notional = Math.min(b.eq * RISK / stopPct, b.eq * MAXLEV); const entry = x.e * (1 + x.s * PAPER_FEE);
      b.pos.push({ c: x.c, s: x.s, entry, stop: x.stop, tp: x.tp, notional, riskU: notional * stopPct, lev: Math.max(1, Math.round(notional / b.eq)), t: now, how: x.how, tfms: G("TFMS[tf]") });
      if (loud) msgs.push(`🤖 總帳戶開倉：${x.s > 0 ? "做多" : "做空"} ${x.c} @ ${G(`fp(${x.e})`)}\n停損 ${G(`fp(${x.stop})`)}・停利 ${G(`fp(${x.tp})`)}・倉位 ${notional.toFixed(0)} U（約 ${Math.max(1, Math.ceil(notional / b.eq))} 倍）\n理由：${x.how}`);
    }
  }
  if (b.log.length > 300) b.log.splice(0, b.log.length - 300);
  for (const m of msgs) { console.log(m.split("\n")[0]); await send(m); }
}
async function paperTick() {
  const bb = bestBook(); st.follow = bb ? bb.k : null;
  for (const k of Object.keys(BOOKS)) await bookTick(k, k === "main" ? st.follow : null);
}
function paperSummary() {
  const days = Math.max(1, Math.ceil((Date.now() - st.books.main.start) / 864e5)), d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const line = k => { const b = st.books[k], s = bookStat(b), ret = (b.eq / b.eq0 - 1) * 100, td = b.log.filter(x => x.end >= d0.getTime()).reduce((a, x) => a + x.pnl, 0); return `${BOOKS[k].split("（")[0]}：${b.eq.toFixed(1)} U（${ret >= 0 ? "+" : ""}${ret.toFixed(1)}%）・${s.n} 筆・勝率 ${(s.win * 100).toFixed(0)}%・每筆平均 ${s.avg >= 0 ? "+" : ""}${s.avg.toFixed(2)}R・今天 ${td >= 0 ? "+" : ""}${td.toFixed(1)} U・持倉 ${b.pos.length}`; };
  const keys = Object.keys(BOOKS).filter(k => k !== "main").sort((a, b) => st.books[b].eq - st.books[a].eq);
  return `🤖 AI 自己摸索（第 ${days} 天，每個帳戶都是虛擬 1000 U、真實行情）\n\n${line("main")}\n總帳戶現在跟著：${st.follow ? BOOKS[st.follow].split("（")[0] : "還沒有策略累積到 10 筆以上又賺錢，先用規則＋相似行情"}\n\n各策略排行：\n` + keys.map(line).join("\n") + `\n\n🎰 隨機亂買是對照組：贏不了它的策略就等於沒用。`;
}
function gitSave() {
  try { execSync('git add data && (git diff --cached --quiet || (git -c user.name="crypto-bot" -c user.email="crypto-bot@users.noreply.github.com" commit -qm "更新 AI 練習帳戶" && git pull --rebase -q && git push -q))', { stdio: "ignore", timeout: 90000 }); console.log("已把練習帳戶存到 GitHub（網頁 1～2 分鐘後看得到）"); }
  catch (e) { console.log("存到 GitHub 這次沒成功，下次再試"); }
}
function paperWrite() {
  const out = { time: Date.now(), follow: st.follow, names: BOOKS, books: {} };
  for (const k of Object.keys(BOOKS)) { const b = st.books[k]; out.books[k] = { ...b, stat: bookStat(b), log: b.log.slice(-60), open: b.pos.map(p => ({ ...p, px: paperPx(p.c) })), vdesc: VARIANTS[k] ? vDesc(k, VARIANTS[k][b.vi || 0]) : "" }; }
  const m = out.books.main; Object.assign(out, { eq0: m.eq0, eq: m.eq, start: m.start, peak: m.peak, log: m.log, open: m.open }); // 相容舊網頁
  writeData("paper.json", out);
}

// ---- 第一輪 ----
await handleCmds(firstCmds);
await newsRiskScan();
modelWrite();
journalUpdate();
let sentN = await alerts();
await heartbeat(firstCmds.some(t => /^\/alive|^\/ping/i.test(t)));
save();

// ---- 接著連續盯盤：每 1 分鐘更新價格，Telegram 指令隨到隨回 ----
let lastUpd = Date.now(), lastOpt = Date.now(), lastJ = Date.now(), ticks = 0;
while (Date.now() - T0 < RUN_MS) {
  const t1 = Date.now();
  const cmds = await pollTG(25);
  if (!cmds.length && Date.now() - t1 < 20000) await sleep(Math.min(25000 - (Date.now() - t1), Math.max(0, RUN_MS - (Date.now() - T0)))); // Telegram 沒等就回來時，避免空轉
  if (Date.now() - T0 >= RUN_MS && !cmds.length) break;
  try {
    if (cmds.length || Date.now() - lastUpd >= 50000) {
      globalThis.__closed = null; G("cloudUpd().then(n=>globalThis.__closed=n,()=>globalThis.__closed=0)");
      for (let i = 0; i < 120 && globalThis.__closed === null; i++) await sleep(500);
      lastUpd = Date.now(); ticks++;
      if (globalThis.__closed) console.log(`${new Date().toLocaleTimeString("zh-TW", { hour12: false })} 有 ${globalThis.__closed} 個幣的K線剛收盤，重新判斷`);
    }
    if (Date.now() - lastOpt > (+process.env.OPT_MIN || 15) * 6e4 && !G("optBusy")) { // 每 15 分鐘用最新K線重新學一次
      G("optimize()"); for (let i = 0; i < 240 && G("optBusy"); i++) await sleep(500);
      lastOpt = Date.now(); console.log(`${new Date().toLocaleTimeString("zh-TW", { hour12: false })} 重新學習完成：規則${G("ACTIVE") ? "通過" : "未通過"}`); modelWrite();
    }
    if (cmds.length) await handleCmds(cmds);
    if (await newsUpdate()) await newsRiskScan();
    if (Date.now() - lastJ > 10 * 6e4) { journalUpdate(); lastJ = Date.now(); }
    sentN += await alerts();
    await hourly();
    await paperTick();
    if (!st.paperW || Date.now() - st.paperW > 15 * 6e4) { paperWrite(); st.paperW = Date.now(); gitSave(); }
    await heartbeat(cmds.some(t => /^\/alive|^\/ping/i.test(t)));
  } catch (e) { console.log("這一輪出錯，下一輪再試：", e.message); }
  save();
}
journalUpdate(); modelWrite(); paperWrite(); save();
console.log(`done：連續盯盤 ${Math.round((Date.now() - T0) / 6e4)} 分鐘、更新價格 ${ticks} 次、送出 ${sentN} 則提醒`);
process.exit(0);
