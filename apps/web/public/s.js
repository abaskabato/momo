// The secure-link page. What the person types is sealed here, in the browser,
// to their own Momo's key. The relay only ever sees the sealed result.
(async () => {
  const id = location.pathname.split("/").filter(Boolean).pop();
  const title = document.getElementById("title");
  const note = document.getElementById("note");
  const form = document.getElementById("f");
  const expired = () => {
    title.textContent = "This link has expired";
    note.textContent = "Ask Momo for a new one.";
  };
  const r = await fetch(`/api/forms/${encodeURIComponent(id)}`, { cache: "no-store" }).catch(() => null);
  if (!r || !r.ok) return expired();
  const { spec, pk } = await r.json();
  const copy = MOMO_COPY[spec.kind];
  if (!copy) return expired();
  const site = (s) => s.split("{site}").join(spec.label);
  document.title = title.textContent = site(copy.title);
  note.textContent = site(copy.note);
  for (const f of copy.fields) {
    const label = document.createElement("label");
    label.htmlFor = f.id;
    label.textContent = f.label;
    const input = document.createElement("input");
    Object.assign(input, { id: f.id, name: f.id, autocomplete: f.auto, required: !f.optional });
    if (f.type) input.type = f.type;
    if (f.mode) input.inputMode = f.mode;
    form.append(label, input);
  }
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Save securely";
  form.append(button);
  form.hidden = false;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    button.disabled = true;
    button.textContent = "Saving…";
    const fields = Object.fromEntries([...form.querySelectorAll("input")].map((i) => [i.name, i.value]));
    const sealed = await momoSeal(pk, JSON.stringify({ formId: id, fields }));
    const res = await fetch(`/api/forms/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sealed }) }).catch(() => null);
    if (res && res.ok) {
      form.hidden = true;
      note.hidden = true;
      document.getElementById("done").hidden = false;
    } else {
      button.disabled = false;
      button.textContent = res && res.status === 410 ? "This link expired. Ask Momo for a new one." : "Try again";
    }
  });
})();
