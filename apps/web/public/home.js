// The example conversation on the home page: a few errands play out, one
// after another, the way they look in a chat. Without this script (or with
// reduced motion) the page keeps the first one, already written in the HTML.
const ERRANDS = [
  [
    ["you", "Table for 2 at Nopa, Friday at 7"],
    ["momo", "On it."],
    ["momo", "Booked. Nopa, Friday 7:15pm, table for 2, under your name. Confirmation TN-48213."],
  ],
  [
    ["you", "Cheapest nonstop from SFO to LAX next Friday morning"],
    ["momo", "On it."],
    ["momo", "Bought. Alaska 7:05am nonstop, $89, seat 14C. The confirmation is in your email; free to cancel for 24 hours."],
  ],
  [
    ["you", "Clear the junk out of my Downloads folder"],
    ["momo", "On it."],
    ["momo", "Done. Moved 14 old installers and duplicates to the Recycle Bin: 2.1 GB freed."],
  ],
];

const thread = document.getElementById("demo");
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function bubble(who, text) {
  const p = document.createElement("p");
  p.className = `msg ${who} in`;
  p.textContent = text;
  return p;
}

async function play() {
  for (let n = 0; ; n = (n + 1) % ERRANDS.length) {
    thread.textContent = "";
    for (const [who, text] of ERRANDS[n]) {
      if (who === "momo") {
        // Momo is working: three dots, then the message.
        const dots = bubble("momo typing", "");
        dots.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
        thread.append(dots);
        await wait(text === "On it." ? 500 : 1500);
        dots.remove();
      } else {
        await wait(900);
      }
      thread.append(bubble(who, text));
      await wait(700);
    }
    await wait(3800);
    thread.classList.add("out");
    await wait(400);
    thread.classList.remove("out");
  }
}

if (thread && !still) play();

// "Settings" in the note under the button opens the panel it points at.
document.getElementById("open-settings")?.addEventListener("click", () => {
  document.getElementById("settings").open = true;
});
