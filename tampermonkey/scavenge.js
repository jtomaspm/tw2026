// ==UserScript==
// @name         Scavenge
// @description  Scavenge Single Village
// @version      1.0.0
// @author       PopAndBoom
// @include      https://*.tribalwars.*/*mode=scavenge*
// @exclude      https://*.tribalwars.*/*mode=scavenge_mass*
// @run-at       document-idle
// ==/UserScript==

const CONFIG = {
    min_village_change_delay_ms: 10 * 1000,
    max_village_change_delay_ms: 60 * 1000,
    send_wait_ms: 1000,
    excluded_units: new Set(["axe", "light", "knight"]),
};

function altAldeia()
{
    $('.arrowRight').click();
    $('.groupRight').click();
}

function next_village() {
    altAldeia();
}

function random_timeout(min_ms, max_ms) {
    return Math.floor(Math.random() * (max_ms - min_ms + 1)) + min_ms;
}

function send_troops({view}) {
    const button = view.getElementsByClassName("btn btn-default free_send_button")[0];

    if (button == null) {
        return false;
    }

    button.click();
    return true;
}

function inactive_views() {
    return [...document.getElementsByClassName("inactive-view")]
        .filter(e => e.getElementsByClassName("btn btn-default free_send_button").length > 0);
}

function unit_inputs() {
    const widget = document.getElementsByClassName("candidate-squad-widget vis")[0];

    if (widget == null) {
        return [];
    }

    return [...widget.getElementsByTagName("td")]
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

function set_units_for_remaining_views(views_count) {
    unit_inputs().forEach(unit => {
        if(CONFIG.excluded_units.has(unit.input.name)) {
            set_input_value(unit.input, 0);
            return;
        }

        set_input_value(unit.input, Math.floor(unit.count / views_count));
    });
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function send_all_scavenges() {
    const attempted_views = new WeakSet();
    let views = inactive_views();

    while(views.length > 0) {
        set_units_for_remaining_views(views.length);
        await wait(CONFIG.send_wait_ms);

        const view = views[views.length - 1];
        attempted_views.add(view);
        send_troops({view});

        await wait(CONFIG.send_wait_ms);
        views = inactive_views().filter(view => !attempted_views.has(view));
    }
}

async function main() {
    await send_all_scavenges();

    setTimeout(next_village, random_timeout(
        CONFIG.min_village_change_delay_ms,
        CONFIG.max_village_change_delay_ms
    ));
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
