// ==UserScript==
// @name         Loot Assistant Fast
// @description  Loot Assistant Fast Micro-Farm. Enable - Include reports from villages you are currently attacking.
// @version      1.0.0
// @author       PopAndBoom
// @include      https://*.tribalwars.*/*screen=am_farm*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// @connect      192.168.1.*
// ==/UserScript==

const CONFIG = {
    backend_url: "http://192.168.1.68:5080",
    ignored_villages: new Set([
        "517|543",
    ]),
    time_between_attacks_ms: 20 * 60 * 1000,
};

function change_village() {
    $('.arrowRight').click();
    $('.groupRight').click();
}

function current_village() {
    const village = document.querySelector("#menu_row2");

    if (village == null) {
        return null;
    }

    const match = village.textContent.match(/\b\d{3}\|\d{3}\b/);
    return match == null ? null : match[0];
}

function current_page() {
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
    const curr = current_page();
    const nav = document.querySelector("#plunder_list_nav");
    const pages = nav == null ? [] : [...nav.querySelectorAll(".paged-nav-item")];
    const next = pages.find(e => parseInt(e.textContent.replace(/\D/g, ""), 10) == curr + 1);

    if (next == null) {
        return null;
    }

    if (next.href == null || next.href == "") {
        next.click();
        return;
    }

    location.href = next.href;
    return curr + 1;
}

function lc_count() {
    const light = document.querySelector("#light");
    return light == null ? 0 : parseInt(light.textContent, 10);
}

function move_to_first_page() {
    const url = new URL(location.href);
    url.searchParams.set("Farm_page", "0");

    if (url.href == location.href) {
        return false;
    }

    location.href = url.href;
    return true;
}

function plunder_list() {
    const list = document.querySelector("#plunder_list");
    if (list == null) return [];

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
                    send_a: send_a == null ? null : () => send_a.click(),
                    send_b: send_b == null ? null : () => send_b.click(),
                };
            })
            .filter(e => e.send_a != null);
}

function attack_url() {
    return new URL("/attack", CONFIG.backend_url);
}

function current_village_url() {
    return new URL("/state/current-village", CONFIG.backend_url);
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

async function register_attack(source_village, target) {
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


async function last_attack_elapsed_ms(source_village, target) {
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

async function main(params) {
    const source_village = current_village();
    const page = current_page();

    if (page != 1) {
        const url = current_village_url().toString();
        const response = await backend_request({method: "GET", url});

        if (response.status < 200 || response.status >= 300) {
            throw new Error("GET /state/current-village failed with status " + response.status);
        }

        if (response.responseText.trim() != source_village) {
            const update_response = await backend_request({
                method: "POST",
                url,
                body: source_village,
            });

            if (update_response.status < 200 || update_response.status >= 300) {
                throw new Error("POST /state/current-village failed with status " + update_response.status);
            }

            move_to_first_page();
            return;
        }
    }

    const pl = plunder_list();
    const timings_url = new URL("/attack/timings", CONFIG.backend_url);
    timings_url.searchParams.set("source", source_village);
    for (const target of pl) {
        timings_url.searchParams.append("targets", target.village);
    }

    const timings_response = await backend_request({
        method: "GET",
        url: timings_url.toString(),
    });

    if (timings_response.status < 200 || timings_response.status >= 300) {
        throw new Error("GET /attack/timings failed with status " + timings_response.status);
    }

    const timings = JSON.parse(timings_response.responseText);

    for (const target of pl) {
        if(lc_count() <= 0) break;
        const elapsed_ms = timings[target.village];
        if (elapsed_ms != null && elapsed_ms <= CONFIG.time_between_attacks_ms) {
            continue;
        }

        await new Promise(resolve => setTimeout(resolve, 300));
        await register_attack(source_village, target);
        target.send_a();
    }

    if (lc_count() <= 0) {
        await new Promise(resolve => setTimeout(resolve, 10000));
        change_village();
    } else {
        await new Promise(resolve => setTimeout(resolve, 1000));
        next_page();
    }
}

await main();
