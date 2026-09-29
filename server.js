// DayChat server murni Node.js (tanpa paket luar). Jalankan: node server.js
const http = require("http"), fs = require("fs"), path = require("path");
try {
  for (const l of fs.readFileSync(path.join(__dirname, ".env.local"), "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !l.trim().startsWith("#")) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}
const E = process.env;
const keys = (p) => [1, 2, 3, 4, 5].map((i) => E[`${p}_${i}`]).filter(Boolean);
const RETRY = new Set([401, 402, 403, 429]);
const M = { otomatis: E.NEXT_PUBLIC_MODEL_OTOMATIS, sedang: E.NEXT_PUBLIC_MODEL_SEDANG, coding: E.NEXT_PUBLIC_MODEL_CODING, konten: E.NEXT_PUBLIC_MODEL_KONTEN, dalam: E.NEXT_PUBLIC_MODEL_LEBIH_DALAM, cerdas: E.NEXT_PUBLIC_MODEL_PALING_CERDAS };

// Rotasi key: coba key 1..5 berurutan sampai berhasil
async function rotate(prefix, call) {
  const ks = keys(prefix);
  if (!ks.length) return { status: 500, body: { error: `${prefix}_1 sampai _5 belum diisi` } };
  let last;
  for (const k of ks) {
    try {
      const r = await call(k);
      const d = await r.json().catch(() => ({}));
      last = { status: r.status, body: d };
      if (r.ok) return last;
      if (!RETRY.has(r.status) && r.status < 500) return last; // bukan masalah key
    } catch (e) { last = { status: 502, body: { error: String(e) } }; }
  }
  return last || { status: 503, body: { error: "Semua API key gagal" } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errMsg = (d) => { const e = d.errors && typeof d.errors === "object" ? Object.values(d.errors).flat()[0] : ""; return [d.message, e].filter(Boolean).join(": ") || "gagal"; };
// deAPI v2 bersifat asinkron: kirim permintaan -> dapat request_id -> polling /jobs/{id} sampai selesai
async function deapi(base, key, prompt, image) {
  const h = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  const model = E.NEXT_PUBLIC_MODEL_IMAGE, seed = Math.floor(Math.random() * 1000000);
  const f = { prompt, model, width: 768, height: 1360, steps: 4, guidance: 0, seed };
  let r;
  if (image) {
    const m = /^data:(.+?);base64,(.*)$/s.exec(image);
    if (!m) return { status: 400, error: "Format gambar tidak valid" };
    const fd = new FormData();
    for (const k in f) fd.append(k, String(f[k]));
    fd.append("image", new Blob([Buffer.from(m[2], "base64")], { type: m[1] }), "image." + (m[1].split("/")[1] || "png").replace("jpeg", "jpg"));
    r = await fetch(`${base}/images/edits`, { method: "POST", headers: h, body: fd });
  } else {
    r = await fetch(`${base}/images/generations`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify(f) });
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { status: r.status, error: errMsg(d) };
  const id = d.data?.request_id;
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const j = await fetch(`${base}/jobs/${id}`, { headers: h });
    if (!j.ok) continue;
    const jd = (await j.json().catch(() => ({}))).data || {};
    if (jd.status === "done") return { status: 200, url: jd.result_url || jd.results_alt_formats?.jpg };
    if (jd.status === "error") return { status: 424, error: "Gagal diproses: " + (jd.error_reason || jd.error_code || "tidak diketahui") };
  }
  return { status: 504, error: "Waktu habis menunggu gambar" };
}
const trim = (u = "") => u.replace(/\/+$/, "");
const routes = {
  "/api/chat": async ({ messages, model }) => {
    const r = await rotate("TEXT2TEXT_API_KEY", (k) => fetch(`${trim(E.NEXT_PUBLIC_TEXT_BASE_URL)}/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` },
      body: JSON.stringify({ model: M[model] || M.otomatis, messages, stream: false }),
    }));
    return r.status < 300 ? { status: 200, body: { text: r.body.choices?.[0]?.message?.content ?? "" } } : r;
  },
  "/api/image": async ({ prompt, image }) => {
    const base = trim(E.NEXT_PUBLIC_IMAGE_BASE_URL);
    let last = { status: 500, error: "IMAGE_API_KEY_1 sampai _5 belum diisi" };
    for (const k of keys("IMAGE_API_KEY")) {
      try {
        const o = await deapi(base, k, prompt, image);
        last = o;
        if (o.status === 200 || o.status === 504 || (!RETRY.has(o.status) && o.status < 500)) break; // ganti key hanya untuk masalah key/limit
      } catch (e) { last = { status: 502, error: String(e) }; }
    }
    return last.status === 200 ? { status: 200, body: { url: last.url } } : { status: last.status, body: { error: last.error } };
  },
};
const WALL = path.join(__dirname, "wallpaper");
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".mp4": "video/mp4", ".webm": "video/webm" };
function sendFile(req, res, fp) {
  const type = MIME[path.extname(fp).toLowerCase()], size = fs.statSync(fp).size;
  const rg = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (rg && (rg[1] || rg[2])) { // dukungan Range agar video bisa diputar & diulang
    let a = rg[1] ? +rg[1] : size - +rg[2], b = rg[1] && rg[2] ? +rg[2] : size - 1;
    if (a > b || a >= size) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": `bytes ${a}-${b}/${size}`, "Content-Length": b - a + 1 });
    return fs.createReadStream(fp, { start: a, end: b }).pipe(res);
  }
  res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": size, "Cache-Control": "no-cache" });
  fs.createReadStream(fp).pipe(res);
}
http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/api/wallpapers") {
    let f = []; try { f = fs.readdirSync(WALL).filter((n) => MIME[path.extname(n).toLowerCase()]); } catch {}
    res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(f));
  }
  if (req.method === "GET" && req.url.startsWith("/wallpaper/")) {
    let name = ""; try { name = path.basename(decodeURIComponent(req.url.slice(11).split("?")[0])); } catch {}
    const fp = path.join(WALL, name);
    if (!MIME[path.extname(name).toLowerCase()] || !fs.existsSync(fp)) { res.writeHead(404); return res.end("Tidak ditemukan"); }
    return sendFile(req, res, fp);
  }
  if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/?"))) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(__dirname, "index.html")));
  }
  const h = routes[req.url];
  if (req.method === "POST" && h) {
    let raw = ""; for await (const c of req) raw += c;
    let out; try { out = await h(JSON.parse(raw || "{}")); } catch (e) { out = { status: 500, body: { error: String(e) } }; }
    res.writeHead(out.status, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(out.body));
  }
  res.writeHead(404); res.end("Tidak ditemukan");
}).listen(process.env.PORT || 3000, "0.0.0.0", () => console.log("DayChat jalan di port " + (process.env.PORT || 3000)));
      
