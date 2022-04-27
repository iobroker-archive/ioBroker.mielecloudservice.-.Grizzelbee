'use strict';

/*
 * Created with @iobroker/create-adapter v2.1.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const EventSource = require('eventsource');
const mieleTools = require('./source/mieleTools.js');
const mieleConst = require('./source/mieleConst');
const timeouts = {};
let adapter;
let events;
let auth;
// const fakeRequests=true;// this switch is used to fake requests against the Miele API and load the JSON-objects from disk

// Load your modules here, e.g.:
class Mielecloudservice extends utils.Adapter {

    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
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
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Reset the connection indicator during startup
        this.setState('info.connection', false, true);
        // remember the link to the adapter instance
        adapter = this;
        // decrypt passwords
        this.config.Client_secret =  this.decrypt(this.config.Client_secret);
        this.config.Miele_pwd =  this.decrypt(this.config.Miele_pwd);
        // test config and get auth token
        try {
            await mieleTools.checkConfig(this, this.config)
                .then(async ()=> {
                    auth = await mieleTools.getAuth(this, this.config, 1)
                        .catch((err)=> {
                            // this.log.error(err);
                            this.terminate(err, 11);
                        });
                    this.log.debug(JSON.stringify(auth));
                })
                .catch(()=> {
                    this.terminate('Terminating adapter due to invalid configuration.', 11);
                });
            if (auth){
                // continue here after config is checked and auth is requested
                // check every 12 hours whether the auth token is going to expire in the next 24 hours; If yes refresh token
                timeouts.authCheck = setInterval(async (adapter, config)=> {
                    this.log.debug(`Testing whether auth token is going to expire within the next 24 hours.`);
                    if (mieleTools.authHasExpired(auth)){
                        auth = await mieleTools.refreshAuthToken(adapter, config, auth)
                            .catch((err)=> {
                                if ( typeof err === 'string'){
                                    adapter.terminate(err);
                                } else {
                                    adapter.log.error(JSON.stringify(err));
                                    adapter.terminate('Terminating adapter due to invalid auth token.');
                                }
                            });
                    }
                }, 12*3600*1000, this, this.config); // org: 12*3600*1000; for testing: 30000
                // code for watchdog -> check every 5 minutes
                timeouts.watchdog=setInterval(()=> {
                    const testValue = new Date();
                    if (Date.parse(testValue.toLocaleString())-Date.parse(auth.ping.toLocaleString())>= 60000){
                        adapter.log.info(`Watchdog detected ping failure. Last ping occurred over a minute ago. Trying to reconnect.`);
                        events = new EventSource(mieleConst.BASE_URL + mieleConst.ENDPOINT_EVENTS, { headers: { Authorization: 'Bearer ' + auth.access_token,'Accept' : 'text/event-stream','Accept-Language' : adapter.config.locale }} );
                    }
                }, mieleConst.WATCHDOG_TIMEOUT);
                // register for events from Miele API
                this.log.info(`Registering for all appliance events at Miele API.`);
                events = new EventSource(mieleConst.BASE_URL + mieleConst.ENDPOINT_EVENTS, { headers: { Authorization: 'Bearer ' + auth.access_token,'Accept' : 'text/event-stream','Accept-Language' : adapter.config.locale }} );

                events.addEventListener( 'devices', function(event) {
                    adapter.log.debug(`Received DEVICES message by SSE: [${JSON.stringify(event)}]`);
                    mieleTools.splitMieleDevices(adapter, auth, JSON.parse(event.data))
                        .catch((err)=>{
                            adapter.log.warn(`splitMieleDevices crashed with error: [${err}]`);
                        });
                });

                events.addEventListener( 'actions', function(actions) {
                    adapter.log.debug(`Received ACTIONS message by SSE: [${JSON.stringify(actions)}]`);
                    adapter.log.debug(`ACTIONS.lastEventId: [${JSON.stringify(actions.lastEventId)}]`);
                    mieleTools.splitMieleActionsMessage(adapter, JSON.parse(actions.data))
                        .catch((err)=>{
                            adapter.log.warn(`splitMieleActionsMessage crashed with error: [${err}]`);
                        });
                });

                events.addEventListener( 'ping', function() {
                    // ping messages usually occur every five seconds.
                    // adapter.log.debug(`Received PING message by SSE.`);
                    auth.ping=new Date();
                });

                events.addEventListener( 'error', function(event) {
                    adapter.log.warn('Received error message by SSE: ' + JSON.stringify(event));
                    if (event.readyState === EventSource.CLOSED) {
                        adapter.log.info('The connection has been closed. Trying to reconnect.');
                        adapter.setState('info.connection', false, true);
                        events = new EventSource(mieleConst.BASE_URL + mieleConst.ENDPOINT_EVENTS, { headers: { Authorization: 'Bearer ' + auth.access_token,'Accept' : 'text/event-stream','Accept-Language' : adapter.config.locale }} );
                    }
                });

                events.onopen = function() {
                    adapter.log.info('Server Sent Events-Connection has been (re)established @Miele-API.');
                };
            }
        } catch (err) {
            this.log.error(err);
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    async onUnload(callback) {
        try {
            // Here you must clear all timeouts or intervals that may still be active
            this.unsubscribeObjects('*');
            this.unsubscribeStates('*');
            this.setState('info.connection', false, true);
            for (const [key] of Object.entries(timeouts) ) {
                this.log.debug(`Clearing ${key} interval.`);
                clearInterval(timeouts[key]);
            }
            events.close();
            if (auth) {
                await mieleTools.APILogOff(this, auth, 'access_token');
            }
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        if (state) {
            // The state was changed
            // this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
            if (state.ack){
                if (id.split('.').pop() === 'Power' && state.val ){
                    // add programs to device when it's powered on, since querying programs powers devices on or throws errors
                    await mieleTools.addProgramsToDevice(adapter, auth, id.split('.', 3).pop());
                }
            } else {
                // manual change / request
                this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
                const adapter= this;
                const payload = {};
                const action  = id.split('.').pop();
                const device  = id.split('.', 3).pop();
                switch(action){
                    case 'Nickname': payload.deviceName = state.val;
                        break;
                    case 'Start': payload.processAction = mieleConst.START;
                        break;
                    case 'Stop': payload.processAction = mieleConst.STOP;
                        break;
                    case 'Pause': payload.processAction = mieleConst.PAUSE;
                        break;
                    case 'SuperFreezing': payload.processAction = (state.val?mieleConst.START_SUPERFREEZING:mieleConst.STOP_SUPERFREEZING);
                        break;
                    case 'SuperCooling': payload.processAction = (state.val?mieleConst.START_SUPERCOOLING:mieleConst.STOP_SUPERCOOLING);
                        break;
                    case 'startTime': payload.startTime = (typeof state.val==='string'?state.val.split(':'):[0,0]);
                        break;
                    case 'ventilationStep': payload.ventilationStep = state.val;
                        break;
                    case 'targetTemperatureZone-1':
                    case 'targetTemperatureZone-2':
                    case 'targetTemperatureZone-3': payload.targetTemperature = {zone:action.split('-').pop(), value: state.val};
                        break;
                    case 'Color': payload.colors = state.val;
                        break;
                    case 'Mode': payload.modes = state.val;
                        break;
                    case 'Light': payload.light = (state.val? 2 : 1);
                        break;
                    case 'Power': (state.val? payload.powerOn=true : payload.powerOff=true);
                        break;
                    case 'LastActionResult':
                        break;
                    default : payload.programId = (typeof action == 'string' ? Number.parseInt(action) : 0);
                        break;
                }
                await mieleTools.executeAction(this, auth, action, device, payload)
                    .then(() => {
                        adapter.setState(`${device}.ACTIONS.LastActionResult`, 'Okay!', true);
                    })
                    .catch((error)=>{
                        adapter.setState(`${device}.ACTIONS.LastActionResult`, error, true);
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
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Mielecloudservice(options);
} else {
    // otherwise, start the instance directly
    new Mielecloudservice();
}