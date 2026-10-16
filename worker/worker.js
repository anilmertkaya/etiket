// SkinSnap Worker v2 — güvenlik güncellemesi
// 1) PIN deneme sınırı (e-posta başına 5, IP başına 20 yanlış deneme / 15 dk) + yeni hesaplarda en az 6 karakter
//    PIN'ler artık PBKDF2 ile saklanır; eski hesaplar ilk girişte otomatik yükseltilir.
// 2) Oturumlar 90 gün sonra sona erer; token'lar veritabanında hash'lenmiş tutulur.
// 3) Ortak havuza yalnızca giriş yapmış kullanıcı yazar, kendi ürününü düzeltebilir, günde en fazla 50 ürün.

const SYSTEM={tr:"Sen SkinSnap adli kozmetik icerik uygulamasinin cilt uzmani asistanisin. Cilt, sac ve tirnak urunlerindeki bilesenler ve cilt bakimi hakkinda kisa, sade ve sicak Turkce yanitlar ver (en fazla 120 kelime). Kesin tibbi iddia yapma; guvenli veya zararli demek yerine dikkat gerektirir gibi tarafsiz ifadeler kullan. Bilmiyorsan soyle. Marka onerme. Gerekirse bir uzmana danisin de. Sadece Turkce yaz.",en:"You are the skin expert assistant of SkinSnap, a cosmetic ingredient app. Give short, plain, warm English answers about ingredients in skin, hair and nail products and skincare (max 120 words). Avoid definitive medical claims; prefer neutral wording like needs attention instead of safe or harmful. Say when you do not know. Do not recommend brands. Add ask a specialist when relevant."};

const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET, POST, PUT, OPTIONS","Access-Control-Allow-Headers":"Content-Type, Authorization"};
const json=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{"Content-Type":"application/json",...CORS}});

const SESSION_TTL=90*24*60*60*1000;   // 90 gün
const LOCK_MS=15*60*1000;             // 15 dakika
const MAX_FAIL_EMAIL=5, MAX_FAIL_IP=20;
const PRODUCTS_PER_DAY=50;

const enc=new TextEncoder();
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
async function sha(s){return hex(await crypto.subtle.digest("SHA-256",enc.encode(s)))}
async function pbkdf2(pin,salt){
  const key=await crypto.subtle.importKey("raw",enc.encode(pin),"PBKDF2",false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt:enc.encode(salt),iterations:100000},key,256);
  return "pbkdf2$"+hex(bits)}
function same(a,b){if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0}
async function checkPin(user,pin){
  if(user.hash.startsWith("pbkdf2$"))return same(await pbkdf2(pin,user.salt),user.hash);
  return same(await sha(user.salt+pin),user.hash)}   // eski (v1) hash
const rnd=()=>crypto.randomUUID().replace(/-/g,"")+crypto.randomUUID().replace(/-/g,"");

let ready=false;
async function ensure(db){if(ready)return;await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE,hash TEXT,salt TEXT,created INTEGER)"),
  db.prepare("CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,uid TEXT,created INTEGER)"),
  db.prepare("CREATE TABLE IF NOT EXISTS data(uid TEXT PRIMARY KEY,json TEXT,updated INTEGER)"),
  db.prepare("CREATE TABLE IF NOT EXISTS products(bar TEXT PRIMARY KEY,json TEXT,uid TEXT,created INTEGER)"),
  db.prepare("CREATE TABLE IF NOT EXISTS attempts(k TEXT PRIMARY KEY,n INTEGER,first INTEGER)")]);ready=true}

/* --- deneme sınırı --- */
async function lockedFor(db,k,max){const r=await db.prepare("SELECT n,first FROM attempts WHERE k=?").bind(k).first();
  if(!r||Date.now()-r.first>LOCK_MS||r.n<max)return 0;return Math.ceil((r.first+LOCK_MS-Date.now())/1000)}
async function addFail(db,k){const now=Date.now();
  await db.prepare("INSERT INTO attempts(k,n,first) VALUES(?1,1,?2) ON CONFLICT(k) DO UPDATE SET n=CASE WHEN ?2-attempts.first>?3 THEN 1 ELSE attempts.n+1 END, first=CASE WHEN ?2-attempts.first>?3 THEN ?2 ELSE attempts.first END").bind(k,now,LOCK_MS).run()}

/* --- oturum --- */
async function newSession(db,uid){const token=rnd();const now=Date.now();
  await db.batch([db.prepare("INSERT INTO sessions(token,uid,created) VALUES(?,?,?)").bind(await sha(token),uid,now),
    db.prepare("DELETE FROM sessions WHERE created<?").bind(now-SESSION_TTL),
    db.prepare("DELETE FROM attempts WHERE first<?").bind(now-LOCK_MS)]);
  return token}
const bearer=req=>(req.headers.get("Authorization")||"").replace("Bearer ","").trim();
async function uidOf(req,db){const t=bearer(req);if(!t)return null;const h=await sha(t);
  const r=await db.prepare("SELECT uid,created FROM sessions WHERE token=?").bind(h).first();if(!r)return null;
  if(Date.now()-r.created>SESSION_TTL){await db.prepare("DELETE FROM sessions WHERE token=?").bind(h).run();return null}
  return r.uid}

export default{
async fetch(req,env){
  if(req.method==="OPTIONS")return new Response(null,{headers:CORS});
  const u=new URL(req.url);const p=u.pathname;const db=env.DB;
  try{
    /* yapay zeka */
    if(p==="/"&&req.method==="POST"){const b=await req.json();const q=String(b.q||"").slice(0,600);const lang=b.lang==="en"?"en":"tr";const ctx=String(b.context||"").slice(0,1500);if(!q)return json({error:"empty"},400);
      const prompt=(ctx?"Baglam: "+ctx+" \n\n":"")+"Soru: "+q;
      const r=await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast",{messages:[{role:"system",content:SYSTEM[lang]},{role:"user",content:prompt}],max_tokens:300});
      return json({answer:r.response||""})}

    await ensure(db);

    /* kayıt ve giriş */
    if((p==="/register"||p==="/login")&&req.method==="POST"){
      const b=await req.json();const email=String(b.email||"").trim().toLowerCase();const pin=String(b.pin||"");
      if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)||email.length>120||pin.length<4||pin.length>32)return json({error:"invalid"},400);
      const ipKey="ip:"+(req.headers.get("CF-Connecting-IP")||"?"),emKey="em:"+email;
      const wait=Math.max(await lockedFor(db,ipKey,MAX_FAIL_IP),await lockedFor(db,emKey,MAX_FAIL_EMAIL));
      if(wait)return json({error:"locked",retry:wait},429);
      let user=await db.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
      if(p==="/register"){
        if(pin.length<6)return json({error:"weakpin"},400);
        if(user)return json({error:"exists"},409);
        await addFail(db,ipKey);   // IP başına hesap açmayı da sınırlar
        const salt=rnd().slice(0,16);const id=rnd().slice(0,24);
        await db.prepare("INSERT INTO users(id,email,hash,salt,created) VALUES(?,?,?,?,?)").bind(id,email,await pbkdf2(pin,salt),salt,Date.now()).run();
        user={id,email}}
      else{
        if(!user){await addFail(db,ipKey);return json({error:"notfound"},404)}
        if(!(await checkPin(user,pin))){await addFail(db,ipKey);await addFail(db,emKey);return json({error:"wrongpin"},401)}
        await db.prepare("DELETE FROM attempts WHERE k=?").bind(emKey).run();
        if(!user.hash.startsWith("pbkdf2$")){const salt=rnd().slice(0,16);await db.prepare("UPDATE users SET hash=?,salt=? WHERE id=?").bind(await pbkdf2(pin,salt),salt,user.id).run()}}
      const token=await newSession(db,user.id);
      const d=await db.prepare("SELECT json FROM data WHERE uid=?").bind(user.id).first();
      return json({token,email,data:d?JSON.parse(d.json):null})}

    /* eşitleme */
    if(p==="/sync"){const uid=await uidOf(req,db);if(!uid)return json({error:"auth"},401);
      if(req.method==="GET"){const d=await db.prepare("SELECT json,updated FROM data WHERE uid=?").bind(uid).first();return json({data:d?JSON.parse(d.json):null,updated:d?d.updated:0})}
      const b=await req.json();const js=JSON.stringify(b.data||{});if(js.length>900000)return json({error:"toolarge"},413);
      await db.prepare("INSERT INTO data(uid,json,updated) VALUES(?,?,?) ON CONFLICT(uid) DO UPDATE SET json=excluded.json,updated=excluded.updated").bind(uid,js,Date.now()).run();
      return json({ok:true})}

    if(p==="/logout"&&req.method==="POST"){const t=bearer(req);if(t)await db.prepare("DELETE FROM sessions WHERE token=?").bind(await sha(t)).run();return json({ok:true})}

    if(p==="/delete"&&req.method==="POST"){const uid=await uidOf(req,db);if(!uid)return json({error:"auth"},401);
      await db.batch([db.prepare("DELETE FROM data WHERE uid=?").bind(uid),db.prepare("DELETE FROM sessions WHERE uid=?").bind(uid),
        db.prepare("UPDATE products SET uid='' WHERE uid=?").bind(uid),db.prepare("DELETE FROM users WHERE id=?").bind(uid)]);
      return json({ok:true})}

    /* ortak ürün havuzu */
    if(p==="/product"&&req.method==="GET"){const bar=u.searchParams.get("bar")||"";if(!/^\d{6,14}$/.test(bar))return json({product:null});
      const r=await db.prepare("SELECT json FROM products WHERE bar=?").bind(bar).first();return json({product:r?JSON.parse(r.json):null})}
    if(p==="/product"&&req.method==="POST"){const uid=await uidOf(req,db);if(!uid)return json({error:"auth"},401);
      const b=await req.json();const pr=b.product||{};const bar=String(pr.bar||"");
      const inci=Array.isArray(pr.inci)?pr.inci.map(x=>String(x).trim().slice(0,100)).filter(Boolean).slice(0,200):[];
      if(!/^\d{6,14}$/.test(bar)||!inci.length)return json({error:"invalid"},400);
      const day=await db.prepare("SELECT COUNT(*) AS c FROM products WHERE uid=? AND created>?").bind(uid,Date.now()-86400000).first();
      if(day&&day.c>=PRODUCTS_PER_DAY)return json({error:"limit"},429);
      const js=JSON.stringify({bar,name:String(pr.name||"").slice(0,120),brand:String(pr.brand||"").slice(0,80),cat:String(pr.cat||"skin").slice(0,10),sub:String(pr.sub||"").slice(0,40),inci,src:"SkinSnap"});
      // yeni ürün eklenir; var olanı yalnızca ekleyen kişi (veya sahipsiz eski kayıtları giriş yapmış biri) günceller
      const r=await db.prepare("INSERT INTO products(bar,json,uid,created) VALUES(?,?,?,?) ON CONFLICT(bar) DO UPDATE SET json=excluded.json,uid=excluded.uid WHERE products.uid=excluded.uid OR products.uid='' OR products.uid IS NULL").bind(bar,js,uid,Date.now()).run();
      return json({ok:true,saved:!!(r.meta&&r.meta.changes)})}

    return json({ok:true,service:"skinsnap-ai"});
  }catch(e){return json({error:"server",detail:String(e).slice(0,200)},500)}
}};
