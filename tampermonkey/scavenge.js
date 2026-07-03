// ==UserScript==
// @name         Scavenge
// @description  Scavenge Single Village
// @version      1.0.0
// @author       PopAndBoom
// @include      https://*.tribalwars.*/*mode=scavenge*
// @exclude      https://*.tribalwars.*/*mode=scavenge_mass*
// @run-at       document-idle
// ==/UserScript==


function next_village() {
    location.reload();
}

function random_timeout(min_ms, max_ms) {
    return Math.floor(Math.random() * (max_ms - min_ms + 1)) + min_ms;
}

function send_troops({view}) {
    view.getElementsByClassName("btn btn-default free_send_button")[0].click();
}

function inactive_views() {
    return [...document.getElementsByClassName("inactive-view")];
}

function unit_inputs() {
    return [...document.getElementsByClassName("candidate-squad-widget vis")[0]
        .getElementsByTagName("td")]
        .filter(e => e.getElementsByClassName("unitsInput input-nicer").length == 1)
        .map(e => ({
            input: e.getElementsByClassName("unitsInput input-nicer")[0],
            count: parseInt(e.getElementsByClassName("units-entry-all squad-village-required")[0].textContent.replace("(","").replace(")",""))
        }));
}

function set_input_value(input, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
    ).set;

    nativeSetter.call(input, String(value));

    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
}

function main() {
    let views = inactive_views();

    if(views.length > 0) {
        unit_inputs().forEach(unit => {
            if(unit.input.name == "axe" || unit.input.name == "light" || unit.input.name == "knight") {
                unit.input.value = 0;
                return;
            }
            set_input_value(unit.input, Math.floor(unit.count / views.length));
        });
        setTimeout(()=>send_troops({view: views[0]}), 1000);
    }

    setTimeout(next_village, random_timeout(2*60*1000, 5*60*1000));
}

function pre_load() {
    let ready = [...document.getElementsByClassName("fill-all")].find(e=>true) != null;

    if (!ready) {
        setTimeout(pre_load, 100);
    } else {
        main();
    }
}

pre_load();
