// ==UserScript==
// @name         Script Snipe - Native Scheduler
// @description  Send a command at an exact server timestamp using a local high-resolution scheduler.
// @version      1.2.0
// @author       PopAndBoom
// @include      https://*.tribalwars.*/*&screen=place*&try=confirm
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @connect      192.168.1.105
// @connect      192.168.1.107
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;

    // Do not allow the native and legacy senders to control the same form.
    if (page.__twNativeSnipeSenderLoaded || page.__twSnipeSenderLoaded) return;
    page.__twNativeSnipeSenderLoaded = true;
    page.__twSnipeSenderLoaded = true;

    const CONFIG = Object.freeze({
        backendUrls: [
            'http://127.0.0.1:5080',
            'http://192.168.1.107:5080',
        ],
        backendUrlKey: 'CS.native.backendUrl',
        offsetKey: 'CS.native.offset',
        wakeLeadKey: 'CS.native.wakeLeadMs',
        defaultOffsetMs: -250,
        latencySamples: 3,
        reconnectLatencySamples: 1,
        calibrationReleaseDelayMs: 200,
        calibrationWakeLeadMs: 750,
        minimumWakeLeadMs: 1500,
        wakeSafetyMarginMs: 500,
        maximumTimerResolutionMs: 5,
        clockIntegrityToleranceMs: 35,
        minimumScheduleLeadMs: 300,
        reconnectDelayMs: 250,
    });

    const Snipe = {
        durationMs: 0,
        wallOffsetMs: 0,
        fireAtServerMs: 0,
        fireAtPerformanceMs: 0,
        backendLatency: null,
        backendSettings: null,
        timerResolutionMs: 0,
        requestedWakeLeadMs: 0,
        jobId: null,
        generation: 0,
        waiter: null,
        fallbackTimer: null,
        reconnectTimer: null,
        reconnectStartedAt: 0,
        formFingerprint: '',
        armed: false,
        scheduling: false,
        dispatching: false,
        backendUrl: CONFIG.backendUrls[0],

        init() {
            this.form = document.querySelector('#command-data-form');
            this.sendButton = document.querySelector(
                '#troop_confirm_submit, .troop_confirm_go'
            );
            const duration = document.querySelector(
                '#date_arrival .relative_time[data-duration]'
            );

            if (!this.form || !this.sendButton || !duration || !page.Timing) {
                return false;
            }

            this.durationMs = Number(duration.dataset.duration) * 1000;
            if (!Number.isFinite(this.durationMs) || this.durationMs <= 0) {
                this.error('Could not read the command travel time.');
                return true;
            }
            if (!this.syncServerWallClock()) {
                this.error('Could not read the Tribal Wars server clock.');
                return true;
            }

            this.createUi();
            this.button.addEventListener('click', () => {
                if (this.armed || this.scheduling) this.cancel();
                else void this.schedule();
            });
            page.addEventListener('pagehide', () => this.cancel(false), {
                capture: true,
                once: true,
            });
            return true;
        },

        serverNow() {
            const raw = page.Timing.getCurrentServerTime();
            let value = raw instanceof Date ? raw.getTime() : Number(raw);
            if (Number.isFinite(value) && value < 100000000000) value *= 1000;
            return value;
        },

        syncServerWallClock() {
            const now = this.serverNow();
            const dateText = document.querySelector('#serverDate')?.textContent.trim();
            const timeText = document.querySelector('#serverTime')?.textContent.trim();
            const dateParts = this.parseServerDate(dateText);
            const time = timeText?.match(/^(\d{1,2}):([0-5]\d):([0-5]\d)$/);

            if (!Number.isFinite(now) || !dateParts || !time) return false;

            const fraction = ((now % 1000) + 1000) % 1000;
            const wallNow = Date.UTC(
                dateParts.year,
                dateParts.month - 1,
                dateParts.day,
                Number(time[1]),
                Number(time[2]),
                Number(time[3]),
                fraction
            );
            this.wallOffsetMs = wallNow - now;
            return true;
        },

        parseServerDate(text) {
            let match = String(text || '').match(
                /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/
            );
            if (match) {
                return {
                    year: Number(match[1]),
                    month: Number(match[2]),
                    day: Number(match[3]),
                };
            }

            match = String(text || '').match(
                /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/
            );
            if (!match) return null;

            // Tribal Wars worlds display this value as day/month/year.
            return {
                year: Number(match[3]),
                month: Number(match[2]),
                day: Number(match[1]),
            };
        },

        createUi() {
            const body = this.form.querySelector('table.vis tbody');
            if (!body) {
                this.error('Could not create the native scheduler controls.');
                return;
            }

            body.insertAdjacentHTML(
                'beforeend',
                '<tr><td>Arrival (native scheduler):</td><td>' +
                '<input type=datetime-local id=CSNtime step=0.001></td></tr>' +
                '<tr><td>Offset (ms):</td><td>' +
                '<input type=number id=CSNoffset step=1> ' +
                '<button type=button id=CSNbutton class=btn>Schedule</button> ' +
                '<span id=CSNstatus aria-live=polite></span></td></tr>' +
                '<tr><td>Native scheduler:</td><td>' +
                '<input type=url id=CSNbackend spellcheck=false></td></tr>'
            );

            this.input = document.querySelector('#CSNtime');
            this.offset = document.querySelector('#CSNoffset');
            this.button = document.querySelector('#CSNbutton');
            this.status = document.querySelector('#CSNstatus');
            this.backendInput = document.querySelector('#CSNbackend');

            const storedOffset = localStorage.getItem(CONFIG.offsetKey);
            const savedOffset = Number(storedOffset);
            this.offset.value =
                storedOffset !== null && Number.isFinite(savedOffset)
                    ? savedOffset
                    : CONFIG.defaultOffsetMs;
            this.backendInput.value =
                localStorage.getItem(CONFIG.backendUrlKey)
                || CONFIG.backendUrls[0];
            this.input.value = this.formatInput(
                this.serverNow() + this.wallOffsetMs + this.durationMs
            );
            this.message('Checking native scheduler...');

            const style = document.createElement('style');
            style.textContent =
                '#CSNtime,#CSNoffset,#CSNbackend{font:9pt Verdana,Arial}' +
                '#CSNoffset{width:75px}' +
                '#CSNbackend{width:230px}' +
                '#CSNstatus[data-state=armed]{color:#146b1f;font-weight:bold}' +
                '#CSNstatus[data-state=warning]{color:#8a5a00;font-weight:bold}' +
                '#CSNstatus[data-state=error]{color:#b40000;font-weight:bold}';
            document.head.appendChild(style);

            void this.checkBackend();
        },

        async checkBackend() {
            try {
                this.backendSettings = await this.readHealth();
                this.message(
                    `Native scheduler ready; ${this.backendSettings.wakeLeadMilliseconds} ms wake lead.`
                );
            } catch {
                this.message(
                    'Native scheduler is offline. Start the backend before scheduling.',
                    'warning'
                );
            }
        },

        async schedule() {
            if (this.scheduling || this.armed) return;
            if (!this.syncServerWallClock()) {
                return this.error('Server clock sync failed.');
            }

            const arrivalWallMs = this.parseInput(this.input.value);
            const offsetMs = Number(this.offset.value);
            if (!Number.isFinite(arrivalWallMs)) {
                return this.error('Use a valid timestamp including milliseconds.');
            }
            if (!Number.isFinite(offsetMs)) {
                return this.error('Offset must be a number of milliseconds.');
            }

            const arrivalServerMs = arrivalWallMs - this.wallOffsetMs;
            const fireAtServerMs =
                arrivalServerMs - this.durationMs + offsetMs;
            const initialRemaining = fireAtServerMs - this.serverNow();
            if (initialRemaining <= CONFIG.minimumScheduleLeadMs) {
                return this.error(
                    `The send time must be at least ${CONFIG.minimumScheduleLeadMs} ms in the future.`
                );
            }

            this.scheduling = true;
            this.input.disabled = true;
            this.offset.disabled = true;
            this.backendInput.disabled = true;
            this.button.textContent = 'Cancel';
            this.message('Synchronizing with native scheduler...', 'armed');

            try {
                this.backendSettings = await this.readHealth();
                this.timerResolutionMs = this.measureTimerResolution();
                if (
                    this.timerResolutionMs
                    > CONFIG.maximumTimerResolutionMs
                ) {
                    throw new Error(
                        `Firefox timer resolution is ${this.timerResolutionMs.toFixed(1)} ms; 5 ms or better is required.`
                    );
                }
                this.backendLatency = await this.measureBackendLatency(
                    CONFIG.latencySamples
                );
                this.requestedWakeLeadMs = this.chooseWakeLead();

                const performanceBeforeMs = performance.now();
                const serverAnchorMs = this.serverNow();
                const performanceAfterMs = performance.now();
                const performanceAnchorMs =
                    (performanceBeforeMs + performanceAfterMs) / 2;
                this.fireAtServerMs = fireAtServerMs;
                this.fireAtPerformanceMs =
                    performanceAnchorMs + (fireAtServerMs - serverAnchorMs);

                const remaining = this.fireAtPerformanceMs - performance.now();
                const requiredLead = Math.max(
                    CONFIG.minimumScheduleLeadMs,
                    this.requestedWakeLeadMs
                    + 25
                );
                if (remaining <= requiredLead) {
                    throw new Error(
                        `Scheduler setup finished too close to the deadline; at least ${Math.ceil(requiredLead)} ms is required.`
                    );
                }

                localStorage.setItem(CONFIG.offsetKey, String(offsetMs));
                localStorage.setItem(
                    CONFIG.backendUrlKey,
                    this.backendUrl
                );
                this.jobId = crypto.randomUUID();
                this.generation = 0;
                this.formFingerprint = this.readFormFingerprint();
                this.reconnectStartedAt = 0;
                this.armed = true;
                this.scheduling = false;
                this.dispatching = false;
                this.armFallbackDiagnostic();
                this.message(
                    `Armed ${this.jobId.slice(0, 8)}; waking ${this.requestedWakeLeadMs} ms early, callback p80 ${this.backendLatency.p80Ms.toFixed(1)} ms.`,
                    'armed'
                );
                this.startWait();
            } catch (error) {
                this.scheduling = false;
                this.restoreControls();
                this.error(error instanceof Error ? error.message : String(error));
            }
        },

        startWait() {
            if (!this.armed) return;

            const generation = ++this.generation;
            const requestStartedAt = performance.now();
            const fireInMilliseconds =
                this.fireAtPerformanceMs - requestStartedAt;
            const minimumRemaining =
                this.requestedWakeLeadMs + 25;

            if (fireInMilliseconds <= minimumRemaining) {
                return this.failClosed(
                    'The scheduler connection started too close to the send deadline.'
                );
            }

            const request = this.gmRequest({
                method: 'POST',
                url: `${this.backendUrl}/snipe/v1/jobs/${this.jobId}/wait`,
                headers: {'Content-Type': 'application/json'},
                data: JSON.stringify({
                    generation,
                    fireInMilliseconds,
                    wakeLeadMilliseconds: this.requestedWakeLeadMs,
                }),
            });
            this.waiter = request;

            request.promise.then((response) => {
                if (!this.armed || generation !== this.generation) return;
                if (response.status < 200 || response.status >= 300) {
                    throw new Error(
                        `Scheduler wait failed with HTTP ${response.status}.`
                    );
                }

                let signal;
                try {
                    signal = JSON.parse(response.responseText);
                } catch {
                    throw new Error('Scheduler returned an invalid wake signal.');
                }

                this.handleWake(signal, generation);
            }).catch((error) => {
                if (!this.armed || generation !== this.generation) return;
                void this.reconnect(error);
            });
        },

        handleWake(signal, generation) {
            if (!this.armed || generation !== this.generation) return;
            if (
                signal.jobId !== this.jobId ||
                Number(signal.generation) !== generation
            ) {
                return this.failClosed('Rejected a mismatched scheduler signal.');
            }

            const targetPerformanceMs = this.fireAtPerformanceMs;
            const now = performance.now();
            const latenessMs = now - targetPerformanceMs;
            const callbackPathMs =
                this.requestedWakeLeadMs
                - (targetPerformanceMs - now);
            this.learnWakeLead(callbackPathMs);
            if (
                !Number.isFinite(targetPerformanceMs) ||
                latenessMs > this.backendSettings.lateToleranceMilliseconds
            ) {
                return this.failClosed(
                    `Scheduler signal was ${Math.max(0, latenessMs).toFixed(1)} ms late.`
                );
            }

            if (this.readFormFingerprint() !== this.formFingerprint) {
                return this.failClosed(
                    'The command form changed after it was armed.'
                );
            }

            const serverRemaining = this.fireAtServerMs - this.serverNow();
            const monotonicRemaining = targetPerformanceMs - now;
            if (
                Math.abs(serverRemaining - monotonicRemaining)
                > CONFIG.clockIntegrityToleranceMs
            ) {
                return this.failClosed(
                    'Clock integrity check failed; the computer may have slept or its clock changed.'
                );
            }

            while (
                this.armed &&
                generation === this.generation &&
                performance.now() < targetPerformanceMs
            ) {
                // The backend wakes this tab early so only the final interval spins.
            }

            if (!this.armed || generation !== this.generation) return;
            const finalLateness = performance.now() - targetPerformanceMs;
            if (finalLateness > this.backendSettings.lateToleranceMilliseconds) {
                return this.failClosed(
                    `The browser resumed ${finalLateness.toFixed(1)} ms late.`
                );
            }

            this.dispatching = true;
            this.armed = false;
            this.clearLocalTimers();
            this.sendButton.click();
        },

        async reconnect(reason) {
            if (!this.armed) return;

            const now = performance.now();
            if (!this.reconnectStartedAt) this.reconnectStartedAt = now;
            const reconnectAge = now - this.reconnectStartedAt;
            const remaining = this.fireAtPerformanceMs - now;
            const safeRemaining =
                this.requestedWakeLeadMs
                + this.backendSettings.lateToleranceMilliseconds
                + 25;

            if (
                reconnectAge > this.backendSettings.reconnectWindowMilliseconds ||
                remaining <= safeRemaining
            ) {
                return this.failClosed(
                    `Native scheduler connection was lost: ${this.errorText(reason)}`
                );
            }

            this.message('Scheduler disconnected; reconnecting...', 'warning');
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = window.setTimeout(async () => {
                if (!this.armed) return;

                try {
                    this.backendSettings = await this.readHealth();
                    this.backendLatency = await this.measureBackendLatency(
                        CONFIG.reconnectLatencySamples
                    );
                    this.requestedWakeLeadMs = this.chooseWakeLead();
                    this.reconnectStartedAt = 0;
                    this.message(
                        `Reconnected ${this.jobId.slice(0, 8)}; waking ${this.requestedWakeLeadMs} ms early.`,
                        'armed'
                    );
                    this.startWait();
                } catch (error) {
                    void this.reconnect(error);
                }
            }, CONFIG.reconnectDelayMs);
        },

        cancel(showMessage = true) {
            const wasActive = this.armed || this.scheduling;
            const jobId = this.jobId;
            const generation = this.generation;

            this.armed = false;
            this.scheduling = false;
            this.generation++;
            this.waiter?.abort();
            this.waiter = null;
            this.clearLocalTimers();

            if (jobId && generation > 0) {
                this.gmRequest({
                    method: 'DELETE',
                    url:
                        `${this.backendUrl}/snipe/v1/jobs/${jobId}` +
                        `?generation=${generation}`,
                }).promise.catch(() => {});
            }

            if (wasActive) {
                this.restoreControls();
                if (showMessage) this.message('Schedule cancelled.');
            }
        },

        failClosed(text) {
            this.cancel(false);
            this.error(text);
        },

        restoreControls() {
            this.input.disabled = false;
            this.offset.disabled = false;
            this.backendInput.disabled = false;
            this.button.disabled = false;
            this.button.textContent = 'Schedule';
        },

        clearLocalTimers() {
            clearTimeout(this.fallbackTimer);
            clearTimeout(this.reconnectTimer);
            this.fallbackTimer = null;
            this.reconnectTimer = null;
        },

        armFallbackDiagnostic() {
            clearTimeout(this.fallbackTimer);
            const delay = Math.max(
                1,
                this.fireAtPerformanceMs - performance.now()
                + this.backendSettings.lateToleranceMilliseconds
                + 10
            );
            this.fallbackTimer = window.setTimeout(() => {
                if (!this.armed) return;
                if (
                    performance.now() >
                    this.fireAtPerformanceMs
                    + this.backendSettings.lateToleranceMilliseconds
                ) {
                    this.failClosed(
                        'No native scheduler signal arrived before the safety deadline.'
                    );
                }
            }, delay);
        },

        async readHealth() {
            let lastError;
            const configuredUrl = this.normalizeBackendUrl(
                this.backendInput?.value
            );
            const candidates = Array.from(new Set([
                configuredUrl,
                localStorage.getItem(CONFIG.backendUrlKey),
                ...CONFIG.backendUrls,
            ].filter(Boolean)));

            for (const backendUrl of candidates) {
                try {
                    const response = await this.gmRequest({
                        method: 'GET',
                        url: `${backendUrl}/snipe/v1/health`,
                        timeout: 1000,
                    }).promise;
                    if (response.status !== 200) {
                        throw new Error(
                            `Native scheduler health check returned HTTP ${response.status}.`
                        );
                    }

                    const health = JSON.parse(response.responseText);
                    if (
                        health.status !== 'ready' ||
                        !Number.isFinite(Number(health.frequency))
                    ) {
                        throw new Error(
                            'Native scheduler health response was invalid.'
                        );
                    }

                    this.backendUrl = backendUrl;
                    return {
                        frequency: Number(health.frequency),
                        wakeLeadMilliseconds: Number(
                            health.wakeLeadMilliseconds
                        ),
                        maximumWakeLeadMilliseconds: Number(
                            health.maximumWakeLeadMilliseconds
                        ),
                        lateToleranceMilliseconds: Number(
                            health.lateToleranceMilliseconds
                        ),
                        reconnectWindowMilliseconds: Number(
                            health.reconnectWindowMilliseconds
                        ),
                        maximumJobs: Number(health.maximumJobs),
                    };
                } catch (error) {
                    lastError = error;
                }
            }

            throw lastError || new Error('Native scheduler is unavailable.');
        },

        normalizeBackendUrl(value) {
            const text = String(value || '').trim().replace(/\/+$/, '');
            if (!text) return '';

            let url;
            try {
                url = new URL(text);
            } catch {
                throw new Error(
                    'Native scheduler URL must be a valid http:// URL.'
                );
            }

            if (url.protocol !== 'http:') {
                throw new Error(
                    'Native scheduler URL must use http:// on the local LAN.'
                );
            }

            return url.origin;
        },

        async measureBackendLatency(sampleCount) {
            const samples = [];

            for (let index = 0; index < sampleCount; index++) {
                const calibrationId = crypto.randomUUID();
                const expectedReleaseMs =
                    CONFIG.calibrationReleaseDelayMs;
                const startedAt = performance.now();
                const response = await this.gmRequest({
                    method: 'POST',
                    url:
                        `${this.backendUrl}/snipe/v1/jobs/` +
                        `${calibrationId}/wait`,
                    headers: {'Content-Type': 'application/json'},
                    data: JSON.stringify({
                        generation: 1,
                        fireInMilliseconds:
                            expectedReleaseMs
                            + CONFIG.calibrationWakeLeadMs,
                        wakeLeadMilliseconds:
                            CONFIG.calibrationWakeLeadMs,
                    }),
                }).promise;
                const finishedAt = performance.now();

                if (response.status !== 200) {
                    throw new Error(
                        `Scheduler callback probe returned HTTP ${response.status}.`
                    );
                }

                samples.push(Math.max(
                    0,
                    finishedAt - startedAt - expectedReleaseMs
                ));
            }

            samples.sort((left, right) => left - right);
            const percentile = (value) => samples[
                Math.min(
                    samples.length - 1,
                    Math.ceil(value * samples.length) - 1
                )
            ];
            const result = {
                minimumMs: samples[0],
                medianMs: percentile(0.5),
                p80Ms: percentile(0.8),
                maximumMs: samples[samples.length - 1],
            };
            return result;
        },

        chooseWakeLead() {
            const maximum = Number(
                this.backendSettings.maximumWakeLeadMilliseconds
            );
            if (!Number.isFinite(maximum) || maximum < 1000) {
                throw new Error(
                    'The native scheduler is outdated. Reinstall and restart tw-backend.'
                );
            }

            const stored = Number(
                localStorage.getItem(CONFIG.wakeLeadKey)
            );
            const measured =
                this.backendLatency.p80Ms + CONFIG.wakeSafetyMarginMs;
            const requested = Math.ceil(Math.max(
                CONFIG.minimumWakeLeadMs,
                this.backendSettings.wakeLeadMilliseconds,
                Number.isFinite(stored) ? stored : 0,
                measured
            ));

            if (requested > maximum) {
                throw new Error(
                    `The required ${requested} ms wake lead exceeds the backend limit of ${maximum} ms.`
                );
            }

            localStorage.setItem(
                CONFIG.wakeLeadKey,
                String(requested)
            );
            return requested;
        },

        learnWakeLead(callbackPathMs) {
            if (!Number.isFinite(callbackPathMs) || callbackPathMs < 0) {
                return;
            }

            const learned = Math.ceil(
                callbackPathMs + CONFIG.wakeSafetyMarginMs
            );
            const maximum =
                this.backendSettings.maximumWakeLeadMilliseconds;
            const next = Math.min(
                maximum,
                Math.max(this.requestedWakeLeadMs, learned)
            );

            if (next > this.requestedWakeLeadMs) {
                localStorage.setItem(
                    CONFIG.wakeLeadKey,
                    String(next)
                );
            }
        },

        measureTimerResolution() {
            const deltas = [];
            const startedAt = performance.now();
            let previous = startedAt;

            while (
                deltas.length < 8 &&
                performance.now() - startedAt < 100
            ) {
                const current = performance.now();
                if (current > previous) {
                    deltas.push(current - previous);
                    previous = current;
                }
            }

            if (!deltas.length) return Infinity;
            return Math.min(...deltas);
        },

        gmRequest(details) {
            let handle;
            const promise = new Promise((resolve, reject) => {
                handle = GM_xmlhttpRequest({
                    ...details,
                    nocache: true,
                    timeout: details.timeout || 0,
                    onload: resolve,
                    onerror: () => reject(new Error('network error')),
                    ontimeout: () => reject(new Error('request timed out')),
                    onabort: () => reject(new Error('request aborted')),
                });
            });

            return {
                promise,
                abort: () => {
                    try {
                        handle?.abort();
                    } catch {
                        // The request already completed.
                    }
                },
            };
        },

        readFormFingerprint() {
            return JSON.stringify(
                Array.from(new FormData(this.form).entries(), ([key, value]) => [
                    key,
                    typeof value === 'string'
                        ? value
                        : `${value.name}:${value.size}:${value.type}`,
                ])
            );
        },

        parseInput(value) {
            const match = String(value).match(
                /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/
            );
            if (!match) return NaN;

            const parts = match.slice(1, 7).map((part) => Number(part || 0));
            const ms = Number((match[7] || '0').padEnd(3, '0'));
            const valueMs = Date.UTC(
                parts[0],
                parts[1] - 1,
                parts[2],
                parts[3],
                parts[4],
                parts[5],
                ms
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
            const pad = (value, length = 2) =>
                String(value).padStart(length, '0');
            return `${date.getUTCFullYear()}-${pad(
                date.getUTCMonth() + 1
            )}-${pad(date.getUTCDate())}T${pad(
                date.getUTCHours()
            )}:${pad(date.getUTCMinutes())}:${pad(
                date.getUTCSeconds()
            )}.${pad(date.getUTCMilliseconds(), 3)}`;
        },

        errorText(error) {
            return error instanceof Error ? error.message : String(error);
        },

        message(text, state = '') {
            if (!this.status) return;
            this.status.textContent = ` ${text}`;
            this.status.dataset.state = state;
        },

        error(text) {
            this.message(text, 'error');
            if (page.UI?.ErrorMessage) page.UI.ErrorMessage(text);
            else console.error(`[Native Snipe Sender] ${text}`);
        },
    };

    const boot = window.setInterval(() => {
        if (Snipe.init()) clearInterval(boot);
    }, 25);
})();
