// ==UserScript==
// @name         Script Snipe
// @description  Send a command so it arrives at an exact server timestamp.
// @version      2.0.0
// @author       PopAndBoom
// @include      https://*.tribalwars.*/*&screen=place*&try=confirm
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    if (window.__twSnipeSenderLoaded) return;
    window.__twSnipeSenderLoaded = true;

    const OFFSET_KEY = 'CS.offset';
    const DEFAULT_OFFSET = -250;
    const FINAL_SPIN_MS = 25;

    const Snipe = {
        durationMs: 0,
        wallOffsetMs: 0,
        fireAtMs: 0,
        timer: null,
        armed: false,

        init() {
            this.form = document.querySelector('#command-data-form');
            this.sendButton = document.querySelector(
                '#troop_confirm_submit, .troop_confirm_go'
            );
            const duration = document.querySelector(
                '#date_arrival .relative_time[data-duration]'
            );

            if (!this.form || !this.sendButton || !duration || !window.Timing) {
                return false;
            }

            this.durationMs = Number(duration.dataset.duration) * 1000;
            if (!Number.isFinite(this.durationMs) || this.durationMs <= 0) {
                this.error('Could not read the command travel time.');
                return true;
            }
            if (!this.syncClock()) {
                this.error('Could not read the Tribal Wars server clock.');
                return true;
            }

            this.createUi();
            this.button.addEventListener('click', () =>
                this.armed ? this.cancel() : this.schedule()
            );
            return true;
        },

        serverNow() {
            const raw = window.Timing.getCurrentServerTime();
            let value = raw instanceof Date ? raw.getTime() : Number(raw);
            if (Number.isFinite(value) && value < 100000000000) value *= 1000;
            return value;
        },

        syncClock() {
            const now = this.serverNow();
            const dateText = document.querySelector('#serverDate')?.textContent.trim();
            const timeText = document.querySelector('#serverTime')?.textContent.trim();
            const date = dateText?.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
            const time = timeText?.match(/^(\d{1,2}):([0-5]\d):([0-5]\d)$/);

            if (!Number.isFinite(now) || !date || !time) return false;

            // The displayed date is DD/MM/YYYY on both the PT and US worlds.
            const fraction = ((now % 1000) + 1000) % 1000;
            const wallNow = Date.UTC(
                Number(date[3]),
                Number(date[2]) - 1,
                Number(date[1]),
                Number(time[1]),
                Number(time[2]),
                Number(time[3]),
                fraction
            );
            this.wallOffsetMs = wallNow - now;
            return true;
        },

        createUi() {
            let input = document.querySelector('#CStime');
            let offset = document.querySelector('#CSoffset');
            let button = document.querySelector('#CSbutton');

            if (!input || !offset || !button) {
                this.form.querySelector('table.vis tbody').insertAdjacentHTML(
                    'beforeend',
                    '<tr><td>Arrival (server time):</td><td>' +
                    '<input type=datetime-local id=CStime step=0.001></td></tr>' +
                    '<tr><td>Offset (ms):</td><td>' +
                    '<input type=number id=CSoffset step=1> ' +
                    '<button type=button id=CSbutton class=btn>Schedule</button> ' +
                    '<span id=CSstatus aria-live=polite></span></td></tr>'
                );
                input = document.querySelector('#CStime');
                offset = document.querySelector('#CSoffset');
                button = document.querySelector('#CSbutton');
            }

            this.input = input;
            this.offset = offset;
            this.button = button;
            this.status = document.querySelector('#CSstatus');
            if (!this.status) {
                this.status = document.createElement('span');
                this.status.id = 'CSstatus';
                this.button.after(this.status);
            }

            const storedOffset = localStorage.getItem(OFFSET_KEY);
            const savedOffset = Number(storedOffset);
            this.offset.value = storedOffset !== null && Number.isFinite(savedOffset)
                ? savedOffset
                : DEFAULT_OFFSET;
            this.input.value = this.formatInput(
                this.serverNow() + this.wallOffsetMs + this.durationMs
            );
            this.button.disabled = false;
            this.button.textContent = 'Schedule';
            this.message('Enter the arrival timestamp, including milliseconds.');

            const style = document.createElement('style');
            style.textContent =
                '#CStime,#CSoffset{font:9pt Verdana,Arial}#CSoffset{width:75px}' +
                '#CSstatus[data-state=armed]{color:#146b1f;font-weight:bold}' +
                '#CSstatus[data-state=error]{color:#b40000;font-weight:bold}';
            document.head.appendChild(style);
        },

        schedule() {
            if (!this.syncClock()) return this.error('Server clock sync failed.');

            const arrivalWallMs = this.parseInput(this.input.value);
            const offsetMs = Number(this.offset.value);
            if (!Number.isFinite(arrivalWallMs)) {
                return this.error('Use a valid timestamp including milliseconds.');
            }
            if (!Number.isFinite(offsetMs)) {
                return this.error('Offset must be a number of milliseconds.');
            }

            localStorage.setItem(OFFSET_KEY, String(offsetMs));
            const arrivalServerMs = arrivalWallMs - this.wallOffsetMs;
            this.fireAtMs = arrivalServerMs - this.durationMs + offsetMs;
            const remaining = this.fireAtMs - this.serverNow();

            if (remaining <= 0) {
                return this.error('That command would need to be sent in the past.');
            }

            this.armed = true;
            this.input.disabled = true;
            this.offset.disabled = true;
            this.button.textContent = 'Cancel';
            this.message('Armed. Keep this tab open and focused.', 'armed');
            this.tick();
        },

        tick() {
            if (!this.armed) return;
            const remaining = this.fireAtMs - this.serverNow();

            if (remaining <= 0) return this.submit();

            if (remaining <= FINAL_SPIN_MS) {
                const deadline = performance.now() + FINAL_SPIN_MS + 10;
                while (this.serverNow() < this.fireAtMs && performance.now() < deadline) {
                    // Busy-wait only for the final few milliseconds.
                }
                return this.submit();
            }

            const delay = remaining > 2000
                ? Math.min(1000, remaining - 1000)
                : Math.max(1, remaining - FINAL_SPIN_MS);
            this.timer = window.setTimeout(() => this.tick(), delay);
        },

        submit() {
            if (!this.armed) return;
            this.armed = false;
            clearTimeout(this.timer);
            this.button.disabled = true;
            this.button.textContent = 'Sending...';
            this.message('Sending command now.', 'armed');
            this.sendButton.click();
        },

        cancel() {
            this.armed = false;
            clearTimeout(this.timer);
            this.input.disabled = false;
            this.offset.disabled = false;
            this.button.textContent = 'Schedule';
            this.message('Schedule cancelled.');
        },

        parseInput(value) {
            const match = String(value).match(
                /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/
            );
            if (!match) return NaN;

            const parts = match.slice(1, 7).map((part) => Number(part || 0));
            const ms = Number((match[7] || '0').padEnd(3, '0'));
            const valueMs = Date.UTC(
                parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5], ms
            );
            const check = new Date(valueMs);
            if (
                check.getUTCFullYear() !== parts[0] ||
                check.getUTCMonth() !== parts[1] - 1 ||
                check.getUTCDate() !== parts[2] ||
                check.getUTCHours() !== parts[3] ||
                check.getUTCMinutes() !== parts[4] ||
                check.getUTCSeconds() !== parts[5] ||
                check.getUTCMilliseconds() !== ms
            ) return NaN;
            return valueMs;
        },

        formatInput(valueMs) {
            const date = new Date(valueMs);
            const pad = (value, length = 2) => String(value).padStart(length, '0');
            return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(
                date.getUTCDate()
            )}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(
                date.getUTCSeconds()
            )}.${pad(date.getUTCMilliseconds(), 3)}`;
        },

        message(text, state = '') {
            if (!this.status) return;
            this.status.textContent = ` ${text}`;
            this.status.dataset.state = state;
        },

        error(text) {
            this.message(text, 'error');
            if (window.UI?.ErrorMessage) window.UI.ErrorMessage(text);
            else console.error(`[Snipe Sender] ${text}`);
        }
    };

    const boot = window.setInterval(() => {
        if (Snipe.init()) clearInterval(boot);
    }, 25);
})();
