// ==UserScript==
// @name         Recruit Stables
// @description  Recruit Stables Troops
// @version      1.0.0
// @author       PopAndBoom
// @include      https://*.tribalwars.*/*screen=stable*
// @run-at       document-idle
// ==/UserScript==

function set_lcs({ count }) {
  document.getElementById("light_0").value = count;
}

function recruit() {
  let btns = document.getElementsByClassName("btn btn-recruit");
  if (btns.length > 0) {
    btns[0].click();
  }
}

function has_queue() {
  try {
    return [... document.getElementById("trainqueue_stable").getElementsByTagName("tr")].find(e => e.id.includes("trainorder")) != null;
  } catch {
    return false;
  }
}

function next_village() {
  location.reload();
}

function random_timeout(min_ms, max_ms) {
  return Math.floor(Math.random() * (max_ms - min_ms + 1)) + min_ms;
}

if (!has_queue()) {
  set_lcs({count: 1});
  recruit();
}

setTimeout(next_village, random_timeout(4*60*1000, 8*60*1000));
