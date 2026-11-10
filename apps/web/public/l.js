// Live view through the relay: the person sees the errand's browser (on their
// own computer) and taps through one step, like a CAPTCHA. Pictures and taps
// travel through the relay for as long as this page is open.
(() => {
  const id = location.pathname.split("/").filter(Boolean).pop();
  const api = `/api/live/${encodeURIComponent(id)}`;
  const reason = document.getElementById("reason");
  const img = document.getElementById("shot");
  const main = document.querySelector("main");
  let busy = false, over = false, src = "";
  const end = (text) => {
    over = true;
    main.innerHTML = "";
    const p = document.createElement("p");
    p.style.fontSize = "18px";
    p.textContent = text;
    main.append(p);
  };
  const post = (b) => fetch(`${api}/act`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).catch(() => null);

  fetch(api, { cache: "no-store" }).then(async (r) => {
    if (!r.ok) return end("This live view has ended. Go back to the chat.");
    reason.textContent = `${(await r.json()).reason} Tap the picture to click. Type below to fill a box.`;
  });

  async function refresh() {
    if (busy || over) return;
    busy = true;
    try {
      const r = await fetch(`${api}/shot`, { cache: "no-store" });
      if (r.status === 410) return end("This live view has ended. Go back to the chat.");
      if (r.status === 200) {
        const u = URL.createObjectURL(await r.blob());
        img.src = u;
        img.hidden = false;
        if (src) URL.revokeObjectURL(src);
        src = u;
      }
    } catch {} finally { busy = false; }
  }
  img.addEventListener("click", async (e) => {
    const b = img.getBoundingClientRect();
    await post({ type: "tap", x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height });
    setTimeout(refresh, 700);
  });
  const t = document.getElementById("t");
  document.getElementById("send").onclick = async () => { await post({ type: "type", text: t.value }); t.value = ""; };
  document.getElementById("enter").onclick = () => post({ type: "type", key: "Enter" });
  document.getElementById("up").onclick = () => post({ type: "scroll", dy: -600 });
  document.getElementById("down").onclick = () => post({ type: "scroll", dy: 600 });
  document.getElementById("done").onclick = async () => { await post({ type: "done" }); end("Thanks! Momo is continuing. You can close this page."); };
  refresh();
  setInterval(refresh, 1500);
})();
