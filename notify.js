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
  } else if (c0 === "/start" || c0 === "/help") posCmd.push("✅ 已連上你的監控機器人（週期 " + TF + "）。\n\n" + HELP);
}
for (const t of posCmd) await send(t);

// ---- 自動提醒 ----
const msgs = JSON.parse(G(`JSON.stringify((()=>{const out=[];
 COINS.forEach(c=>{const a=A[c];if(!a)return;const q=judge(c);
  if(q.sig&&!q.weak){const p=planOf(c);out.push({k:"sig|"+tf+"|"+c+"|"+a.lastT,t:"✅ 現在可以"+(q.sig.s.s>0?"做多":"做空")+" "+c+"（"+tf+"）\\n進場區間 "+fp(p.lo)+"～"+fp(p.hi)+"\\n停損 "+fp(p.stop)+"\\n停利 "+fp(p.tp)+"\\n有效到這根K線收盤（還有 "+closeIn(c)+"）\\n歷史勝率 "+a.bt.win.toFixed(0)+"%・平均 "+f2(a.bt.avg)+"（"+a.bt.n+" 筆）"})}
  else if(ACTIVE&&a.bt&&a.bt.n>=3&&a.bt.avg>0){const p=planOf(c);if(p&&!p.now&&p.inZone)out.push({k:"zone|"+tf+"|"+c+"|"+a.lastT,t:"⏰ "+c+" 進入"+(p.s>0?"做多":"做空")+"預估區 "+fp(p.lo)+"～"+fp(p.hi)+"（"+tf+"）\\nK線 "+closeIn(c)+" 後收盤，收盤符合條件才會變成可以進場。"})}});
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
