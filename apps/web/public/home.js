// The example on the home page: a text is typed, the answer comes back, then
// the next one. Without this script (or with reduced motion) the page keeps
// the first example, already written in the HTML.
const EXAMPLES = [
  ["Table for 2 at Nopa, Friday at 7", "Booked. Friday 7:15pm, under your name."],
  ["Cheapest nonstop to LA next Friday morning", "Bought. Alaska 7:05am, $89. Free to cancel for 24 hours."],
  ["Refill my prescription at Walgreens", "Done. Ready for pickup after 2pm tomorrow."],
  ["Clear the junk out of my Downloads folder", "Done. 2.1 GB moved to the Recycle Bin."],
];

const box = document.getElementById("demo");
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function play() {
  const ask = box.querySelector(".ask");
  const done = box.querySelector(".done");
  await wait(3200); // the first example is already on the page
  for (let n = 1; ; n = (n + 1) % EXAMPLES.length) {
    box.classList.add("out");
    await wait(450);
    const [text, result] = EXAMPLES[n];
    ask.textContent = "";
    ask.classList.remove("sent");
    done.classList.remove("in");
    done.textContent = result;
    box.classList.remove("out");
    await wait(350);
    for (const ch of text) {
      ask.textContent += ch;
      await wait(26 + Math.random() * 34);
    }
    await wait(500);
    ask.classList.add("sent");
    await wait(900);
    done.classList.add("in");
    await wait(3800);
  }
}

if (box && !still) play();

// "Settings" in the note under the button opens the panel it points at.
document.getElementById("open-settings")?.addEventListener("click", () => {
  document.getElementById("settings").open = true;
});
