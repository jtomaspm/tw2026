// ==UserScript==
// @name         Loot Assistant
// @description  Loot Assistant Micro-Farm. Enable - Include reports from villages you are currently attacking.
// @version      1.0.0
// @author       PopAndBoom
// @include      https://*.tribalwars.*/*screen=am_farm*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// @connect      192.168.1.68
// @connect      192.168.1.105
// @connect      192.168.1.107
// ==/UserScript==

const CONFIG = {
    backend_url: "http://192.168.1.68:5080",
    ignored_villages: new Set([
        "517|543",
    ]),
    time_between_attacks_ms: 20 * 60 * 1000,
    min_empty_units_village_change_delay_ms: 1 * 60 * 1000,
    max_empty_units_village_change_delay_ms: 2 * 60 * 1000,
    send_timeout_ms: 300,
    page_load_wait_ms: 1000,
    after_send_check_ms: 700,
    max_actions_per_second: 5,
};

let last_action_at = 0;
let empty_units_check_scheduled = false;
let skipped_targets = new Set();
let source_village = current_village();

function altVillage()
{
    $('.arrowRight').click();
    $('.groupRight').click();
}


function lc_count() {
    const light = document.querySelector("#light");
    return light == null ? 0 : parseInt(light.textContent, 10);
}

function current_village() {
    const village = document.querySelector("#menu_row2");

    if (village == null) {
        return null;
    }

    const match = village.textContent.match(/\b\d{3}\|\d{3}\b/);
    return match == null ? null : match[0];
}

function page() {
    const farm_page = new URLSearchParams(location.search).get("Farm_page");
    if (farm_page != null) {
        const parsed_page = parseInt(farm_page, 10);
        return isNaN(parsed_page) ? 1 : parsed_page + 1;
    }

    const current_page = [...document.querySelectorAll(".paged-nav-item")]
        .map(e => parseInt(e.textContent.replace(/\D/g, ""), 10))
        .find(e => !isNaN(e));

    return current_page == null ? 1 : current_page;
}

function next_page() {
    const curr = page();
    const nav = document.querySelector("#plunder_list_nav");
    const pages = nav == null ? [] : [...nav.querySelectorAll(".paged-nav-item")];
    const next = pages.find(e => parseInt(e.textContent.replace(/\D/g, ""), 10) == curr + 1);

    if (next == null) {
        return null;
    }

    run_action(() => {
        if (next.href == null || next.href == "") {
            next.click();
            return;
        }

        location.href = next.href;
    });
    skipped_targets = new Set();
    return curr + 1;
}

function plunder_list() {
    const list = document.querySelector("#plunder_list");

    if (list == null) {
        return [];
    }

    return [...list.querySelectorAll("tr")]
            .filter(e => e.id.startsWith("village"))
            .map(e => {
                const columns = e.querySelectorAll("td");
                const village_link = columns[3] == null ? null : columns[3].querySelector("a");
                const plunder_img = columns[2] == null ? null : columns[2].querySelector("img");
                const send_a = columns[8] == null ? null : columns[8].querySelector("a");
                const send_b = columns[9] == null ? null : columns[9].querySelector("a");

                return {
                    id: e.id,
                    village: village_link == null ? "" : (village_link.textContent.match(/\(([^)]+)\)/) || ["", ""])[1],
                    is_attacking: columns[3] != null && columns[3].querySelector("img") != null,
                    last_plunder_full: plunder_img != null && (plunder_img.getAttribute("data-title") || "").startsWith("Full"),
                    distance: columns[7] == null ? NaN : parseFloat(columns[7].textContent),
                    send_a: send_a == null ? null : () => run_action(() => send_a.click()),
                    send_b: send_b == null ? null : () => run_action(() => send_b.click()),
                };
            })
            .filter(e => e.send_a != null && !skipped_targets.has(e.id));
}

function min_action_interval() {
    return Math.ceil(1000 / CONFIG.max_actions_per_second);
}

function run_action(callback) {
    const now = Date.now();
    const action_at = Math.max(now, last_action_at + min_action_interval());

    last_action_at = action_at;
    setTimeout(callback, action_at - now);
    return action_at - now;
}

function random_timeout(min_ms, max_ms) {
    return Math.floor(Math.random() * (max_ms - min_ms + 1)) + min_ms;
}

function attack_url() {
    return new URL("/attack", CONFIG.backend_url);
}

function backend_request({method, url, body}) {
    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method,
            url,
            headers: body == null ? {} : {"Content-Type": "application/json"},
            data: body == null ? undefined : JSON.stringify(body),
            onload: resolve,
            onerror: reject,
            ontimeout: reject,
        });
    });
}

async function last_attack_elapsed_ms(target) {
    const url = attack_url();
    url.searchParams.set("source", source_village);
    url.searchParams.set("target", target.village);

    const response = await backend_request({
        method: "GET",
        url: url.toString(),
    });

    if (response.status == 404) {
        return null;
    }

    if (response.status < 200 || response.status >= 300) {
        throw new Error("GET /attack failed with status " + response.status);
    }

    const elapsed_ms = parseInt(response.responseText, 10);

    if (isNaN(elapsed_ms)) {
        throw new Error("GET /attack returned invalid elapsed time: " + response.responseText);
    }

    return elapsed_ms;
}

async function can_attack(target) {
    const elapsed_ms = await last_attack_elapsed_ms(target);

    if (elapsed_ms == null) {
        return true;
    }

    return elapsed_ms > CONFIG.time_between_attacks_ms;
}

async function register_attack(target) {
    const response = await backend_request({
        method: "POST",
        url: attack_url().toString(),
        body: {
            source: source_village,
            target: target.village,
        },
    });

    if (response.status < 200 || response.status >= 300) {
        throw new Error("POST /attack failed with status " + response.status);
    }
}

function change_village() {
    run_action(altVillage);
}

function current_village_is_ignored() {
    return CONFIG.ignored_villages.has(source_village);
}

function move_to_first_page() {
    const url = new URL(location.href);
    url.searchParams.set("Farm_page", "0");

    if (url.href == location.href) {
        return false;
    }

    run_action(() => {location.href = url.href;});
    return true;
}

function change_village_if_units_still_empty() {
    if (empty_units_check_scheduled) {
        return;
    }

    empty_units_check_scheduled = true;
    const timeout = random_timeout(
        CONFIG.min_empty_units_village_change_delay_ms,
        CONFIG.max_empty_units_village_change_delay_ms
    );

    console.log("[Loot Assistant] Units empty. Checking again before changing village in " + Math.round(timeout / 1000) + "s.");

    setTimeout(() => {
        empty_units_check_scheduled = false;

        if (lc_count() <= 0) {
            change_village();
            return;
        }

        setTimeout(main, CONFIG.send_timeout_ms);
    }, timeout);
}

function continue_after_page() {
    if (next_page() == null) {
        skipped_targets = new Set();

        if (!move_to_first_page()) {
            setTimeout(main, CONFIG.page_load_wait_ms);
        }

        return;
    }

    setTimeout(main, CONFIG.page_load_wait_ms);
}

async function main() {
    if (source_village == null) {
        console.error("[Loot Assistant] Could not read current village coordinate.");
        return;
    }

    if (current_village_is_ignored()) {
        console.log("[Loot Assistant] Ignoring source village " + source_village + ". Changing village.");
        change_village();
        return;
    }

    let lcs = lc_count();

    console.log("LCs: " + lcs);
    console.log("PAGE: " + page());
    console.log("SOURCE: " + source_village);

    if (lcs <= 0) {
        change_village_if_units_still_empty();
        return;
    }

    let target = plunder_list()[0];

    if (target == null) {
        continue_after_page();
        return;
    }

    try {
        if (!await can_attack(target)) {
            console.log("[Loot Assistant] Skipping recently attacked target: " + target.village);
            skipped_targets.add(target.id);
            setTimeout(main, CONFIG.send_timeout_ms);
            return;
        }

        await register_attack(target);
    } catch (error) {
        console.error("[Loot Assistant] Backend attack check failed:", error);
        skipped_targets.add(target.id);
        setTimeout(main, CONFIG.send_timeout_ms);
        return;
    }

    target.send_a();
    skipped_targets.add(target.id);

    setTimeout(() => {
        if (lc_count() >= lcs) {
            skipped_targets.add(target.id);
        }

        setTimeout(main, CONFIG.send_timeout_ms);
    }, CONFIG.after_send_check_ms);
}

main();
