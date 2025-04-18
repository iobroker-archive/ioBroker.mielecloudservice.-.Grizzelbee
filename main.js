'use strict';

/*
 * Created with @iobroker/create-adapter v2.1.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const { EventSource } = require('eventsource');
const mieleTools = require('./source/mieleTools.js');
const mieleConst = require('./source/mieleConst');
const timeouts = {};
const fakeRequests = false; // this switch is used to fake requests against the Miele API and load the JSON-objects from disk
let events;
let auth;
let connectionErrorHandlingInProgress = false;

// Load your modules here, e.g.:
class Mielecloudservice extends utils.Adapter {
    /**
     * @param [options] {object} link to the adapter instance
     */
    constructor(options) {
        super({
            ...options,
            name: 'mielecloudservice',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Requests and opens a new EventSource (SSE - Server-Sent-Events) Connection
     *
     * @returns the new EventSource connection
     */
    getEventSource() {
        const result = new EventSource(mieleConst.BASE_URL + mieleConst.ENDPOINT_EVENTS, {
            fetch: (input, init) =>
                fetch(input, {
                    ...init,
                    headers: {
                        Authorization: `Bearer ${auth.access_token}`,
                        Accept: 'text/event-stream',
                        'Accept-Language': this.config.locale,
                        'User-Agent': mieleConst.UserAgent,
                    }, //-> an option to test: , https:{rejectUnauthorized: false}
                }),
        });
        // @ts-expect-error Property 'sseErrors' does not exist on type 'EventSource'.
        result.sseErrors = 0;
        return result;
    }

    /**
     * does the SSE connection error handling in case an error is reported by the server
     *
     * @param adapter {object} link to the current adapter instance
     * @param events  {object} link to the current EventSource connection
     */
    doSSEErrorHandling(adapter, events) {
        if (connectionErrorHandlingInProgress) {
            adapter.log.info(`SSE connection error handling already in progress.`);
        } else {
            connectionErrorHandlingInProgress = true;
            try {
                switch (events.readyState) {
                    case 0:
                        {
                            // CONNECTING
                            adapter.log.info(
                                `SSE is trying to reconnect but it seems this won't work. So trying myself by closing and reinitializing.`,
                            );
                            events.close();
                            while (events.readyState === 0) {
                                const randomDelay =
                                    Math.pow(events.sseErrors, 2) * 1000 + Math.floor(Math.random() * 1000);
                                timeouts.getEvents = setTimeout(() => {
                                    adapter.initSSE();
                                    adapter.log.info(`Still trying to connect...`);
                                }, randomDelay);
                            }
                        }
                        break;
                    case 1: // OPEN
                        adapter.log.info(`SSE connection is still open or open again. Doing nothing.`);
                        break;
                    case 2: // CLOSED
                        adapter.log.info(`SSE connection has been closed. Trying to reinitialize.`);
                        adapter.initSSE();
                        break;
                    default:
                        adapter.log.warn(
                            `SSE readyState should be [0,1,2] but has an illegal state(${events.readyState}).`,
                        );
                        break;
                }
            } finally {
                connectionErrorHandlingInProgress = false;
            }
        }
    }

    /**
     * Initialize new EventSource and handle all occurring events
     */
    initSSE() {
        // Initialize new EventSource
        events = this.getEventSource();

        /**
         * Handle message type 'open'.
         * It occurs when an SSE connection has been established
         */
        events.onopen = () => {
            this.log.info(
                `Server Sent Events-Connection has been ${events.sseErrors === 0 ? 'established' : 'reestablished'} @Miele-API.`,
            );
            this.setState('info.connection', true, true);
            events.sseErrors = 0;
        };

        /**
         * Handle message type 'device'.
         * It occurs when a device changes one of its states and on initialization
         */
        events.addEventListener(mieleConst.DEVICES, event => {
            this.log.debug(`Received DEVICES message by SSE: [${JSON.stringify(event)}]`);
            mieleTools.splitMieleDevices(this, auth, JSON.parse(event.data)).catch(err => {
                this.log.warn(`splitMieleDevices crashed with error: [${err}]`);
            });
        });

        /**
         * Handle message type 'action'.
         * It occurs when a device changes its available actions and on initialization
         */
        events.addEventListener(mieleConst.ACTIONS, event => {
            this.log.debug(`Received ACTIONS message by SSE: [${JSON.stringify(event)}]`);
            mieleTools.splitMieleActionsMessage(this, JSON.parse(event.data)).catch(err => {
                this.log.warn(`splitMieleActionsMessage crashed with error: [${err}]`);
            });
        });

        /**
         * Handle message type 'ping'.
         * It occurs periodically (usually every five seconds).
         * It's used to feed the watchdog
         */
        events.addEventListener(mieleConst.PING, event => {
            this.log.debug(`Received PING message by SSE: ${JSON.stringify(event)}`);
            auth.ping = new Date();
        });

        /**
         * Handle message type 'error'.
         * It occurs when the Miele-API detects an error
         */
        events.addEventListener(mieleConst.ERROR, event => {
            events.sseErrors++;
            this.setState('info.connection', false, true);
            this.log.debug(`Received error message by SSE: ${JSON.stringify(event)}`);
            const randomDelay = Math.pow(events.sseErrors, 2) * 1000 + Math.floor(Math.random() * 1000);
            if (Object.prototype.hasOwnProperty.call(timeouts, 'reconnectDelay')) {
                clearTimeout(timeouts.reconnectDelay);
            }
            this.log.warn(
                `An ${typeof event.message != 'undefined' ? `error (#${events.sseErrors}) occurred (${event.message})` : 'undefined error occurred'}. Handling it in ${randomDelay / 1000} seconds to give it a chance to solve itself.`,
            );
            timeouts.reconnectDelay = setTimeout(
                (adapter, events) => {
                    // @ts-expect-error Property 'reconnectInterval' does not exist on type 'Event'.
                    event.reconnectInterval = randomDelay;
                    this.doSSEErrorHandling(adapter, events);
                },
                randomDelay,
                this,
                events,
            );
        });
    }

    /**
     * Does time based data polling in case the SSE doesn't work properly
     * can be chosen in the adapters config
     *
     * @param adapter {object} link to the current adapter instance
     * @param auth    {object} link to the current authentication object
     */
    doDataPolling(adapter, auth) {
        timeouts.datapolling = setInterval(
            async function () {
                // getDeviceInfos
                const devices = await mieleTools.refreshMieleDevices(adapter, auth).catch(error => {
                    adapter.log.info(`Devices-Error: ${JSON.stringify(error)}`);
                });
                auth.ping = new Date();
                // processDeviceInfos
                mieleTools.splitMieleDevices(adapter, auth, devices).catch(err => {
                    adapter.log.warn(`splitMieleDevices crashed with error: [${err}]`);
                });
                timeouts.actionsDelay = setTimeout(async function () {
                    const knownDevices = mieleTools.getKnownDevices();
                    const keys = Object.keys(knownDevices);
                    adapter.log.debug(
                        keys.length === 0
                            ? `There are no known devices; No actions to query`
                            : `There are ${keys.length} known devices; querying actions for them.`,
                    );
                    for (let n = 0; n < keys.length; n++) {
                        // getActions
                        adapter.log.debug(`Querying device ${knownDevices[keys[n]].name}`);
                        const actions = await mieleTools
                            .refreshMieleActions(adapter, auth, knownDevices[keys[n]].API_ID)
                            .catch(error => {
                                adapter.log.info(`Actions-Error: ${JSON.stringify(error)}`);
                            });
                        adapter.log.debug(`Actions: ${JSON.stringify(actions)}`);
                        // processDeviceActions
                        mieleTools.splitMieleActionsMessage(adapter, actions).catch(err => {
                            adapter.log.warn(`splitMieleActionsMessage crashed with error: [${err}]`);
                        });
                    }
                }, 1000);
            },
            adapter.config.pollInterval * adapter.config.pollUnit * 1000,
        );
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Reset the connection indicator during startup
        await this.setState('info.connection', false, true);
        // remember the link to the adapter instance
        if (fakeRequests) {
            const fs = require('fs');
            fs.readFile('test/testdata.devices.json', 'utf8', (err, data) => {
                if (err) {
                    throw err;
                }
                this.log.info(`Device test data: ${data.toString()}`);
                mieleTools.splitMieleDevices(this, {}, JSON.parse(data.toString()));
            });
            timeouts.fakeRequest = setTimeout(() => {
                fs.readFile('test/testdata.actions.json', 'utf8', (err, data) => {
                    if (err) {
                        throw err;
                    }
                    this.log.info(`Actions test data: ${data.toString()}`);
                    mieleTools.splitMieleActionsMessage(this, JSON.parse(data.toString()));
                    timeouts.terminateDelay = setTimeout(() => {
                        this.terminate('Processing of test data completed. Nothing more to do.', 11);
                    }, 5000);
                });
            }, 5000);
        } else {
            // test config and get auth token
            try {
                await mieleTools
                    .checkConfig(this, this.config)
                    .then(async () => {
                        auth = await mieleTools.getAuth(this, this.config, 1).catch(err => {
                            // this.log.error(err);
                            this.terminate(err, 11);
                        });
                    })
                    .catch(() => {
                        this.terminate('Terminating adapter due to invalid configuration.', 11);
                    });
                if (auth) {
                    // continue here after config is checked and auth is requested
                    // check every 12 hours whether the auth token is going to expire in the next 24 hours; If yes refresh token
                    timeouts.authCheck = setInterval(
                        async () => {
                            this.log.debug(`Testing whether auth token is going to expire within the next 24 hours.`);
                            if (mieleTools.authHasExpired(auth)) {
                                auth = await mieleTools.refreshAuthToken(this, this.config, auth).catch(err => {
                                    if (typeof err === 'string') {
                                        this.terminate(err);
                                    } else {
                                        this.log.error(JSON.stringify(err));
                                        this.terminate('Terminating adapter due to invalid auth token.');
                                    }
                                });
                            }
                        },
                        mieleConst.AUTH_CHECK_TIMEOUT,
                        this,
                        this.config,
                    );
                    // register for events from Miele API
                    if (this.config.sse) {
                        this.log.info(`Registering for all appliance events at Miele API.`);
                        this.initSSE();
                        /**
                         * code for watchdog
                         * -> check every 5 minutes whether pings are missing
                         */
                        this.log.info(`Initializing SSE watchdog.`);
                        timeouts.watchdog = setInterval(() => {
                            const testValue = new Date();
                            if (testValue.getTime() - auth.ping.getTime() >= mieleConst.WATCHDOG_TIMEOUT) {
                                this.log.info(
                                    `Watchdog detected ping failure. Last ping occurred over a minute ago. Trying to handle.`,
                                );
                                this.setState('info.connection', false, true);
                                events.close();
                                this.initSSE();
                            }
                        }, mieleConst.WATCHDOG_TIMEOUT);
                    } else {
                        this.log.info(
                            `Requesting data from Miele API using time based polling every ${this.config.pollInterval * this.config.pollUnit} Seconds.`,
                        );
                        this.doDataPolling(this, auth);
                    }
                }
            } catch (err) {
                this.log.error(err);
            }
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param callback  {function} callback function to be called after clean up
     */
    async onUnload(callback) {
        try {
            // Here you must clear all timeouts or intervals that may still be active
            this.unsubscribeObjects('*');
            this.unsubscribeStates('*');
            await this.setState('info.connection', false, true);
            for (const [key] of Object.entries(timeouts)) {
                this.log.debug(`Clearing ${key} interval.`);
                clearInterval(timeouts[key]);
            }
            events.close();
            if (auth) {
                await mieleTools.APILogOff(this, auth, 'access_token');
            }
            callback();
        } catch (e) {
            this.log.error(`Error during unload: ${e.message} - ${e.stack}`);
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     *
     * @param id    {string} the state's id
     * @param state {object} the state's object
     */
    async onStateChange(id, state) {
        if (state) {
            // The state was changed
            // this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
            if (state.ack) {
                if (id.split('.').pop() === 'Power' && state.val) {
                    // add programs to device when it's powered on, since querying programs powers devices on or throws errors
                    await mieleTools.addProgramsToDevice(this, auth, id.split('.', 3).pop());
                }
            } else {
                // manual change / request
                this.log.debug(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
                const payload = {};
                let endpoint;
                const action = id.split('.').pop();
                const device = id.split('.', 3).pop();
                endpoint = mieleConst.ENDPOINT_ACTIONS.replace('LANG', this.config.locale);
                switch (action) {
                    case 'Nickname':
                        payload.deviceName = state.val;
                        break;
                    case 'Start':
                        payload.processAction = mieleConst.START;
                        break;
                    case 'Stop':
                        payload.processAction = mieleConst.STOP;
                        break;
                    case 'Pause':
                        payload.processAction = mieleConst.PAUSE;
                        break;
                    case 'SuperFreezing':
                        payload.processAction = state.val
                            ? mieleConst.START_SUPERFREEZING
                            : mieleConst.STOP_SUPERFREEZING;
                        break;
                    case 'SuperCooling':
                        payload.processAction = state.val
                            ? mieleConst.START_SUPERCOOLING
                            : mieleConst.STOP_SUPERCOOLING;
                        break;
                    case 'startTime':
                        payload.startTime = typeof state.val === 'string' ? state.val.split(':') : [0, 0];
                        break;
                    case 'VentilationStep':
                        payload.ventilationStep = state.val;
                        break;
                    case 'targetTemperatureZone-1':
                    case 'targetTemperatureZone-2':
                    case 'targetTemperatureZone-3':
                        payload.targetTemperature = [{ zone: action.split('-').pop(), value: state.val }];
                        break;
                    case 'Color':
                        payload.colors = state.val;
                        break;
                    case 'Mode':
                        payload.modes = state.val;
                        break;
                    case 'Light':
                        payload.light = state.val ? 1 : 2;
                        break;
                    case 'Power':
                        state.val ? (payload.powerOn = true) : (payload.powerOff = true);
                        break;
                    case 'LastActionResult':
                        break;
                    default:
                        payload.programId = typeof action == 'string' ? Number.parseInt(action) : 0;
                        endpoint = mieleConst.ENDPOINT_PROGRAMS.replace('LANG', this.config.locale);
                        break;
                }
                await mieleTools
                    .executeAction(this, auth, endpoint, device, payload)
                    .then(() => {
                        this.setState(`${device}.ACTIONS.LastActionResult`, 'Okay!', true);
                    })
                    .catch(error => {
                        this.setState(`${device}.ACTIONS.LastActionResult`, error, true);
                    });
            }
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param [options] {object} link to the adapter instance
     */
    module.exports = options => new Mielecloudservice(options);
} else {
    // otherwise, start the instance directly
    new Mielecloudservice();
}
