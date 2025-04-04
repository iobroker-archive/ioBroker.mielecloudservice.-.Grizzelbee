'use strict';

// required files to load
const axios = require('axios');
const oauth = require('axios-oauth-client');
const mieleConst = require('../source/mieleConst.js');
const flatted = require('flatted');
const knownDevices = {}; // structure of _knownDevices{deviceId: {name:'', icon:'', deviceFolder:''}, ... }
const queuedMessage = {};
let delayTimeOut;

/**
 * checkConfig
 *
 * tests the given adapter config whether it is valid
 *
 * @param adapter link to the adapter instance
 * @param config link to the adapters' configuration
 * @param config.Client_ID Miele API client-ID of the user as given by Miele
 * @param config.Client_secret Miele API client-secret of the user as given by Miele
 * @param config.Miele_account Miele-account of the user like used in the Miele-APP usually his eMail
 * @param config.Miele_pwd personal Miele-pwd of the user like used in the Miele-APP
 * @param config.oauth2_vg Miele oauth2_vg of the user (country of miele account)
 * @param config.locale    locale the API responds in
 * @returns true if config is valid. false if config is invalid
 */
module.exports.checkConfig = async function (adapter, config) {
    return new Promise((resolve, reject) => {
        let configIsValid = true;
        if ('' === config.Miele_account) {
            adapter.log.warn('Miele account is missing.');
            configIsValid = false;
        }
        if ('' === config.Miele_pwd) {
            adapter.log.warn('Miele password is missing.');
            configIsValid = false;
        }
        if ('' === config.Client_ID) {
            adapter.log.warn('Miele API client ID is missing.');
            configIsValid = false;
        }
        if ('' === config.Client_secret) {
            adapter.log.warn('Miele API client secret is missing.');
            configIsValid = false;
        }
        if ('' === config.locale) {
            adapter.log.warn('Locale is missing.');
            configIsValid = false;
        }
        if ('' === config.oauth2_vg) {
            adapter.log.warn('OAuth2_vg is missing.');
            configIsValid = false;
        }
        if (configIsValid) {
            resolve(configIsValid);
        } else {
            reject(configIsValid);
        }
    });
};

/**
 * Function APIGetAccessToken
 *
 * logs in into Miele Cloud API and requests an OAuth2 Access token
 *
 * @param adapter link to the adapter instance
 * @param config link to the adapters' configuration
 * @param config.Client_ID Miele API client-ID of the user as given by Miele
 * @param config.Client_secret Miele API client-secret of the user as given by Miele
 * @param config.Miele_account Miele-account of the user like used in the Miele-APP usually his eMail
 * @param config.Miele_pwd personal Miele-pwd of the user like used in the Miele-APP
 * @param config.oauth2_vg Miele oauth2_vg of the user (country of miele account)
 * @param config.locale    locale the API responds in
 * @param iteration    count of API login attempts
 * @returns OAuth2 token
 */
module.exports.getAuth = async function (adapter, config, iteration) {
    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve, reject) => {
        adapter.log.info(`Login attempt #${iteration} @Miele-API`);
        // @ts-ignore
        const getOwnerCredentials = await oauth.client(axios.create(), {
            url: mieleConst.BASE_URL + mieleConst.ENDPOINT_TOKEN,
            grant_type: 'password',
            client_id: config.Client_ID,
            client_secret: config.Client_secret,
            username: config.Miele_account,
            password: config.Miele_pwd,
            vg: config.oauth2_vg,
        });
        const auth = await getOwnerCredentials().catch(error => {
            if (error.response) {
                // The request was made and the server responded with a status code
                // that falls out of the range of 2xx
                switch (error.response.status) {
                    case 401: // unauthorized
                        adapter.log.error(
                            'Error: Unable to authenticate user! Your credentials seem to be invalid. Please double check and fix them.',
                        );
                        adapter.log.warn('Credentials used for login:');
                        adapter.log.warn(`options Miele_account: [${config.Miele_account}]`);
                        adapter.log.warn(`options Miele_Password: [${config.Miele_pwd}]`);
                        adapter.log.warn(`options Client_ID: [${config.Client_ID}]`);
                        adapter.log.warn(`options Client_Secret: [${config.Client_secret}]`);
                        adapter.log.warn(`options country: [${config.oauth2_vg}]`);
                        adapter.log.error('IMPORTANT!! Mask/Delete your credentials when posting your log online!');
                        reject(`Terminating adapter due to inability to authenticate.`);
                        break;
                    case 429: // endpoint currently not available
                        adapter.log.warn(
                            `Error: Endpoint: [${mieleConst.BASE_URL}${mieleConst.ENDPOINT_TOKEN}] is currently not available.`,
                        );
                        break;
                    default:
                        adapter.log.warn(
                            `[error.response.data]: ${typeof error.response.data === 'object' ? '' : error.response.data}`,
                        );
                        adapter.log.warn(
                            `[error.response.status]: ${typeof error.response.status === 'object' ? '' : error.response.status}`,
                        );
                        adapter.log.warn(
                            `[error.response.headers]: ${typeof error.response.headers === 'object' ? '' : error.response.headers}`,
                        );
                        break;
                }
            } else if (error.request) {
                // The request was made but no response was received
                // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
                // http.ClientRequest in node.js
                adapter.log.warn(
                    `[error.request]: ${typeof error.request === 'object' ? 'The request was made but no response was received' : error.request}`,
                );
                adapter.log.warn(error);
            } else {
                // Something happened in setting up the request that triggered an Error
                adapter.log.warn(error.message);
            }
            const randomDelay = 1000 * mieleConst.RESTART_TIMEOUT + iteration * 1000 + Math.floor(Math.random() * 1000);
            adapter.log.info(`Login attempt wasn't successful. Connection retry in ${randomDelay / 1000} Seconds.`);
            setTimeout(function () {
                resolve(exports.getAuth(adapter, config, iteration + 1));
            }, randomDelay);
        });
        if (auth) {
            auth.expiryDate = new Date();
            auth.ping = new Date();
            auth.expiryDate.setSeconds(auth.expires_in);
            adapter.log.info(`Access token expires on: ${auth.expiryDate.toLocaleString()}`);
            adapter.setState('info.connection', true, true);
            resolve(auth);
        }
    });
};

/**
 * refreshMieleData
 *
 * polls the miele cloud API to refresh the device data
 *
 * @param adapter {object} link to the adapter instance
 * @param auth {object}  OAuth2 object containing required credentials
 */
module.exports.refreshMieleDevices = async function (adapter, auth) {
    try {
        return await sendAPIRequest(adapter, auth, `v1/devices/?language=${adapter.config.locale}`, 'GET', '');
    } catch (error) {
        adapter.log.error(`[refreshMieleDevices] [${error}] |-> JSON.stringify(error):${JSON.stringify(error)}`);
    }
};

/**
 * refreshMieleData
 *
 * polls the miele cloud API to refresh the device data
 *
 * @param adapter {object} link to the adapter instance
 * @param auth {object}  OAuth2 object containing required credentials
 * @param device {string}
 */
module.exports.refreshMieleActions = async function (adapter, auth, device) {
    try {
        const result = {};
        result[device] = await sendAPIRequest(adapter, auth, `v1/devices/${device}/actions/`, 'GET', '');
        return result;
    } catch (error) {
        adapter.log.error(`[refreshMieleActions] [${error}] |-> JSON.stringify(error):${JSON.stringify(error)}`);
    }
};

module.exports.getKnownDevices = function () {
    return knownDevices;
};

/**
 * sendAPIRequest
 *
 * build and send a http request to the miele server
 *
 * @param adapter link to the adapter instance
 * @param auth OAuth2 token object
 * @param Endpoint the URI endpoint to call
 * @param Method method to use for this request: POST or GET
 * @param payload payload for this request
 */
async function sendAPIRequest(adapter, auth, Endpoint, Method, payload) {
    return new Promise((resolve, reject) => {
        // addressing sentry issues: MIELECLOUDSERVICE-2J, MIELECLOUDSERVICE-2K, MIELECLOUDSERVICE-7
        if (!auth || typeof auth === 'undefined' || Endpoint === '' || Method === '') {
            reject(
                `[sendAPIRequest] Aborting request due to: ${typeof auth === 'undefined' ? 'Missing auth token.' : Endpoint === '' ? 'Missing endpoint.' : 'No method (GET/POST) given.'}`,
            );
        }
        // build options object for axios
        const options = {
            headers: {
                Authorization: `Bearer ${auth.access_token}`,
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': mieleConst.UserAgent,
            },
            method: Method,
            data: payload,
            dataType: 'json',
            json: true,
            url: mieleConst.BASE_URL + Endpoint,
        };
        adapter.log.debug(`Doing axios request: ${JSON.stringify(options)}`);
        // @ts-ignore
        axios(options)
            .then(response => {
                if (Object.prototype.hasOwnProperty.call(response, 'data')) {
                    if (Object.prototype.hasOwnProperty.call(response.data, 'message')) {
                        adapter.log.debug(`API returned Information: [${JSON.stringify(response.data.message)}]`);
                        resolve(response.data.message);
                    } else {
                        adapter.log.debug(`API returned Status: [${response.status}]`);
                        switch (response.status) {
                            case 202:
                                resolve({ message: 'Accepted, processing has not been completed.' });
                                break;
                            case 204: // OK, No Content
                                resolve({ message: 'OK, no content.' });
                                break;
                            default:
                                resolve(response.data);
                        }
                    }
                }
            })
            .catch(error => {
                if (error.response) {
                    switch (error.response.status) {
                        case 400:
                            {
                                const device = Endpoint.split('/', 3).pop();
                                adapter.log.debug(
                                    `The API returned http-error 400: ${error.response.data.message} for device: [${knownDevices[device].name} (${device})].`,
                                );
                                reject(error.response.data.message);
                            }
                            break;
                        case 401:
                            adapter.log.error(
                                "OAuth2 Access token has expired. This shouldn't ever happen.Please open an issue on github for that.",
                            );
                            reject('OAuth2 Access token has expired.');
                            break;
                        case 404:
                            adapter.log.info('Device/fabNumber is unknown. Disabling all actions.');
                            resolve(mieleConst.ALL_ACTIONS_DISABLED);
                            break;
                        case 500:
                            adapter.log.info(
                                'HTTP 500: Internal Server Error @Miele-API servers. There is nothing you can do but waiting if if solves itself or get in contact with Miele.',
                            );
                            reject('Error 500: Internal Server Error.');
                            break;
                        case 504:
                            adapter.log.info(
                                'HTTP 504: Gateway Timeout! This error occurred outside of this adapter. Please google it for possible reasons and solutions.',
                            );
                            reject('Error 504: Gateway timeout');
                            break;
                        default:
                            reject(error.response.data.message);
                            break;
                    }
                    // Request made and server responded
                    adapter.log.debug(`Request made and server responded: ${flatted.stringify(error.response)}`);
                } else if (error.request) {
                    // The request was made but no response was received
                    adapter.log.warn(
                        `The request was made but no response was received: [${flatted.stringify(error.request)}]`,
                    );
                    reject(error);
                } else {
                    // Something happened in setting up the request that triggered an Error
                    adapter.log.warn(
                        `Something happened in setting up the request that triggered an Error: [${flatted.stringify(error)}]`,
                    );
                    reject(error);
                }
            });
    });
}

/**
 * Test whether the auth token is going to expire within the next 24 hours
 *
 * @param auth the current auth token with all it's values
 * @param auth.expiryDate the current expiry date of the token
 * @returns Returns true if the token is going to expire within the next 24 hours - false if not.
 */
module.exports.authHasExpired = function (auth) {
    const testValue = new Date();
    const diffHours = (new Date(auth.expiryDate).getTime() - testValue.getTime()) / 1000 / 60;
    return diffHours <= 24;
};

/**
 * refreshes the current access token when it is obout to expire
 *
 * @param adapter link to the adapter instance
 * @param config  link to the adapters' config
 * @param auth    link to the auth object
 * @returns returns a refreshed auth object in case of success; error object if it fails
 */
module.exports.refreshAuthToken = async function (adapter, config, auth) {
    adapter.log.info(`Your access token is going to expire within the next 24 hours. Trying to refresh it.`);
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                // Authorization: 'Bearer ' + auth.access_token,
                Accept: 'application/json;charset=utf-8',
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': mieleConst.UserAgent,
            },
            method: 'POST',
            data: `grant_type=refresh_token&client_id=${config.Client_ID}&client_secret=${config.Client_secret}&refresh_token=${auth.refresh_token}`,
            dataType: 'text/plain',
            url: mieleConst.BASE_URL + mieleConst.ENDPOINT_TOKEN,
        };
        // @ts-ignore
        axios(options)
            .then(result => {
                result = JSON.parse(flatted.stringify(result));
                const data = result[result[0].data];
                const newAuth = {};
                newAuth.access_token = result[data.access_token];
                newAuth.refresh_token = result[data.refresh_token];
                newAuth.token_type = result[data.token_type];
                newAuth.expires_in = data.expires_in;
                newAuth.expiryDate = new Date();
                newAuth.ping = new Date();
                newAuth.expiryDate.setSeconds(data.expires_in);
                adapter.log.debug(`NewAuth from server: ${JSON.stringify(newAuth)}`);
                adapter.log.info(`New Access-Token expires on: [${newAuth.expiryDate.toLocaleString()}]`);
                resolve(newAuth);
            })
            .catch(error => {
                adapter.log.error(JSON.stringify(error));
                if (error.response) {
                    // The request was made and the server responded with a status code
                    // that falls out of the range of 2xx
                    switch (error.response.status) {
                        case 401: // unauthorized
                            adapter.log.error(
                                'Error: Unable to authenticate user! Your credentials seem to be invalid. Please double check and fix them.',
                            );
                            reject(`Terminating adapter due to inability to authenticate.`);
                            break;
                        case 429: // endpoint currently not available
                            adapter.log.warn(
                                `Error: Endpoint: [${mieleConst.BASE_URL}${mieleConst.ENDPOINT_TOKEN}] is currently not available.`,
                            );
                            break;
                        default:
                            adapter.log.warn(
                                `[error.response.data]: ${typeof error.response.data === 'object' ? '' : error.response.data}`,
                            );
                            adapter.log.warn(
                                `[error.response.status]: ${typeof error.response.status === 'object' ? '' : error.response.status}`,
                            );
                            adapter.log.warn(
                                `[error.response.headers]: ${typeof error.response.headers === 'object' ? '' : error.response.headers}`,
                            );
                            break;
                    }
                } else if (error.request) {
                    // The request was made but no response was received
                    // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
                    // http.ClientRequest in node.js
                    adapter.log.warn(
                        `[error.request]: ${typeof error.request === 'object' ? 'The request was made but no response was received' : error.request}`,
                    );
                    adapter.log.warn(error);
                } else {
                    // Something happened in setting up the request that triggered an Error
                    adapter.log.warn(error.message);
                }
                adapter.log.info(
                    `Refresh attempt wasn't successful. Trying again to refresh in ${mieleConst.RESTART_TIMEOUT} Seconds.`,
                );
                setTimeout(() => {
                    exports.refreshAuthToken(adapter, config, auth);
                }, 1000 * mieleConst.RESTART_TIMEOUT);
            });
    });
};

/**
 * Function APILogOff
 *
 * performs logoff action to the miele cloud API
 *
 * @param adapter {object} link to the adapter instance
 * @param auth {object} OAuth2 token object
 * @param token_type {string} the type of the token to invalidate
 */
module.exports.APILogOff = async function (adapter, auth, token_type) {
    adapter.log.debug(`[APILogOff] Invalidating access tokens.`);
    sendAPIRequest(adapter, auth, mieleConst.ENDPOINT_LOGOUT, 'POST', { token: `${auth[token_type]}` })
        .then(result => {
            return result;
        })
        .catch(error => {
            adapter.log.error(`[APILogOff] ${JSON.stringify(error)}`);
            return error;
        });
};

/**
 * send an action to the API to execute it
 *
 * @param adapter link to the adapter instance
 * @param auth the auth object
 * @param endpoint the API endpoint to call
 * @param device API-ID of the current device
 * @param payload payload to send to the API
 * @returns
 */
module.exports.executeAction = async function (adapter, auth, endpoint, device, payload) {
    return new Promise(function (resolve, reject) {
        if (typeof device === 'undefined' || device === '') {
            reject(`Tried to execute an action with no device given. Aborting.`);
        } else {
            resolve(sendAPIRequest(adapter, auth, endpoint.replace('DEVICEID', device), 'PUT', payload));
        }
    });
};

/**
 * Function splitMieleDevices
 *
 * splits the json data received from cloud API into separate device
 *
 * @param adapter Link to the adapter instance
 * @param auth Link to the authentication object
 * @param mieleDevices The whole JSON which needs to be split into devices
 * @param mieleDevices.ident Indent Data of the device
 * @param mieleDevices.ident.deviceIdentLabel The whole JSON which needs to be split into devices
 * @param mieleDevices.ident.deviceIdentLabel.fabNumber SerialNumber of the device
 */
module.exports.splitMieleDevices = async function (adapter, auth, mieleDevices) {
    // Splits the data-package returned by the API into single devices and iterates over each single device
    for (const mieleDevice in mieleDevices) {
        if (typeof mieleDevices === 'undefined' || typeof mieleDevice === 'undefined') {
            adapter.log.debug(
                `splitMieleDevices: Given dataset is undefined or not splittable. Returning without action.`,
            );
            return;
        } else if (typeof knownDevices[mieleDevice] === 'undefined') {
            adapter.log.debug(`Device ${mieleDevice} isn't already known. Registering now...`);
            adapter.log.debug(
                `splitMieleDevices: ${mieleDevice}: [${mieleDevice}] *** Value: [${JSON.stringify(mieleDevices[mieleDevice])}]`,
            );
            knownDevices[mieleDevice] = {};
            knownDevices[mieleDevice].lastMessage = Date.now();
            knownDevices[mieleDevice].icon = `icons/${mieleDevices[mieleDevice].ident.type.value_raw}.svg`;
            knownDevices[mieleDevice].API_ID = mieleDevice;
            knownDevices[mieleDevice].deviceType = mieleDevices[mieleDevice].ident.type.value_raw;
            if (mieleDevices[mieleDevice].ident.deviceName === '') {
                knownDevices[mieleDevice].name = mieleDevices[mieleDevice].ident.type.value_localized;
            } else {
                knownDevices[mieleDevice].name = mieleDevices[mieleDevice].ident.deviceName;
            }
            const obj = {
                type: 'device',
                common: {
                    name: knownDevices[mieleDevice].name,
                    read: true,
                    write: false,
                    icon: `icons/${mieleDevices[mieleDevice].ident.type.value_raw}.svg`,
                    type: 'object',
                },
            };
            await createOrExtendObject(adapter, mieleDevice, obj, null); // create base object
        }
        // device is already known
        if (adapter.config.delayedProcessing) {
            if (Date.now() - knownDevices[mieleDevice].lastMessage < adapter.config.messageDelay) {
                adapter.log.debug(`Too many messages in a short period. Discarding message.`);
                // queue message
                queuedMessage.device = mieleDevice;
                queuedMessage.ident = mieleDevices[mieleDevice].ident;
                queuedMessage.state = mieleDevices[mieleDevice].state;
                // kill running timeout
                clearTimeout(delayTimeOut);
                // start new timeout
                delayTimeOut = setTimeout(
                    async queuedMessage => {
                        await createIdentTree(adapter, `${queuedMessage.device}.IDENT`, queuedMessage.ident);
                        await createStateTree(
                            adapter,
                            queuedMessage.device,
                            mieleDevices[queuedMessage.device],
                            queuedMessage.state,
                        );
                        knownDevices[mieleDevice].lastMessage = Date.now();
                    },
                    adapter.config.messageDelay,
                    queuedMessage,
                );
                // process queued message if timeout is reached
            } else {
                adapter.log.debug(`Last Event happened long enough ago. Processing message immediately.`);
                await createIdentTree(adapter, `${mieleDevice}.IDENT`, mieleDevices[mieleDevice].ident);
                await createStateTree(adapter, mieleDevice, mieleDevices[mieleDevice], mieleDevices[mieleDevice].state);
                knownDevices[mieleDevice].lastMessage = Date.now();
            }
        } else {
            await createIdentTree(adapter, `${mieleDevice}.IDENT`, mieleDevices[mieleDevice].ident);
            await createStateTree(adapter, mieleDevice, mieleDevices[mieleDevice], mieleDevices[mieleDevice].state);
        }
    }
};

/**
 *
 * @param adapter
 * @param auth
 * @param mieleDevice
 * @returns
 */
module.exports.addProgramsToDevice = async function (adapter, auth, mieleDevice) {
    // query supported programs of this device if needed
    if (Object.prototype.hasOwnProperty.call(knownDevices[mieleDevice], 'programs')) {
        adapter.log.debug(
            `Programs for device ${knownDevices[mieleDevice].name} are already registered. Skipping Query.`,
        );
    } else {
        adapter.log.debug(`KnownDevices before querying programs: ${JSON.stringify(knownDevices[mieleDevice])}`);
        await addPrograms(adapter, auth, mieleDevice);
    }
};

/**
 * createIdentTree
 *
 * add selected ident data to the device tree
 *
 * @param adapter link to the adapter instance
 * @param path path where the data point is going to be created
 * @param currentDeviceIdent ident data of the device
 */
async function createIdentTree(adapter, path, currentDeviceIdent) {
    await createChannelIdent(adapter, path);
    await createString(
        adapter,
        `${path}.ComModFirmware`,
        'The release version of the communication module',
        currentDeviceIdent.xkmIdentLabel.releaseVersion,
    );
    await createString(
        adapter,
        `${path}.ComModTechType`,
        'The technical type of the communication module',
        currentDeviceIdent.xkmIdentLabel.techType,
    );
    await createString(
        adapter,
        `${path}.DeviceSerial`,
        'The serial number of the device',
        currentDeviceIdent.deviceIdentLabel.fabNumber,
    );
    await createString(
        adapter,
        `${path}.DeviceTechType`,
        'The technical type of the device',
        currentDeviceIdent.deviceIdentLabel.techType,
    );
    await createString(
        adapter,
        `${path}.DeviceType`,
        currentDeviceIdent.type.key_localized,
        currentDeviceIdent.type.value_localized,
    );
    await createNumber(
        adapter,
        `${path}.DeviceType_raw`,
        'Device type as number',
        currentDeviceIdent.type.value_raw,
        '',
        '',
    );
    await createString(
        adapter,
        `${path}.DeviceMatNumber`,
        'The material number of the device',
        currentDeviceIdent.deviceIdentLabel.matNumber,
    );
}

/**
 * Function addMieleDeviceState
 *
 * adds the current miele device states to the device tree beneath its device type folder (channel) and device Id (device)
 *
 * @param adapter link to the adapter instance
 * @param path {string} path where the device is to be created (aka deviceFolder)
 * @param currentDevice {object} the entire JSON for the current device
 * @param currentDeviceState {object} the JSON for a single device
 * @param currentDeviceState.status {object} the JSON for the status structure of a single device
 * @param currentDeviceState.status.key_localized {string} the localized name of the key
 * @param currentDeviceState.status.value_localized {string} the localized value
 * @param currentDeviceState.status.value_raw {any} the raw value
 * @param currentDeviceState.signalFailure {boolean} indicator that there is an open failure message for this device
 * @param currentDeviceState.signalInfo {boolean} indicator that there is an open Info message for this device
 * @param currentDeviceState.signalDoor {boolean} indicator that there is an open door message for this device
 * @param currentDeviceState.ProgramID {object} the JSON for the status structure of a single device
 * @param currentDeviceState.programType {object} the JSON for the status structure of a single device
 * @param currentDeviceState.programPhase {object} the JSON for the status structure of a single device
 * @param currentDeviceState.remainingTime {object} the JSON for the status structure of a single device
 * @param currentDeviceState.remoteEnable {object} the JSON for the status structure of a single device
 * @param currentDeviceState.remoteEnable.fullRemoteControl {boolean} the JSON for the status structure of a single device
 * @param currentDeviceState.remoteEnable.smartGrid {boolean} the JSON for the status structure of a single device
 * @param currentDeviceState.remoteEnable.mobileStart {boolean} the JSON for the status structure of a single device
 * @param currentDeviceState.startTime {object} the JSON for the status structure of a single device
 * @param currentDeviceState.elapsedTime {object} the JSON for the status structure of a single device
 * @param currentDeviceState.ecoFeedback {object} the JSON for the status structure of a single device
 * @param currentDeviceState.spinningSpeed {object} the JSON for the status structure of a single device
 * @param currentDeviceState.targetTemperature {object} the JSON for the status structure of a single device
 * @param currentDeviceState.dryingStep {object} the JSON for the status structure of a single device
 * @param currentDeviceState.temperature {object} the JSON for the status structure of a single device
 * @param currentDeviceState.plateStep {object} the JSON for the status structure of a single device
 * @param currentDeviceState.ventilationStep {object} the JSON for the status structure of a single device
 * @param currentDeviceState.batteryLevel {object} the JSON for the status structure of a single device
 * @param currentDeviceState.status {object} the JSON for the status structure of a single device
 * @param currentDeviceState.status {object} the JSON for the status structure of a single device
 * @param currentDeviceState.status {object} the JSON for the status structure of a single device
 */
async function createStateTree(adapter, path, currentDevice, currentDeviceState) {
    // create for ALL devices
    await createStateDeviceMainState(
        adapter,
        `${path}.${currentDeviceState.status.key_localized}`,
        currentDeviceState.status.value_localized,
        currentDeviceState.status.value_raw,
    );
    await createStateSignalFailure(adapter, path, currentDeviceState.signalFailure);
    // set the values for self designed redundant state indicators
    await createStateConnected(adapter, path, currentDeviceState.status.value_raw !== 255);
    await createStateSignalInUse(adapter, path, currentDeviceState.status.value_raw !== 1);
    // nickname action is supported by all devices
    await addDeviceNicknameAction(adapter, path, currentDevice);
    try {
        // set/create device dependant states
        switch (currentDevice.ident.type.value_raw) {
            case 1: // 1 = WASHING MACHINE*
                // setup ecoFeedback channel for this device if needed
                await createChannelEcoFeedback(adapter, path);
                // states the device is known to support
                await createStateProgramID(
                    adapter,
                    `${path}.${currentDeviceState.ProgramID.key_localized}`,
                    currentDeviceState.ProgramID.value_localized,
                    currentDeviceState.ProgramID.value_raw,
                );
                await createStateProgramType(
                    adapter,
                    `${path}.${currentDeviceState.programType.key_localized}`,
                    currentDeviceState.programType.value_localized,
                    currentDeviceState.programType.value_raw,
                );
                await createStateProgramPhase(
                    adapter,
                    `${path}.${currentDeviceState.programPhase.key_localized}`,
                    currentDeviceState.programPhase.value_localized,
                    currentDeviceState.programPhase.value_raw,
                );
                await createStateRemainingTime(adapter, path, currentDeviceState.remainingTime);
                await createStateSignalDoor(adapter, path, currentDeviceState.signalDoor);
                await createStateStartTime(adapter, path, currentDeviceState.startTime);
                await createStateSignalInfo(adapter, path, currentDeviceState.signalInfo);
                await createStateFullRemoteControl(adapter, path, currentDeviceState.remoteEnable.fullRemoteControl);
                await createStateSmartGrid(adapter, path, currentDeviceState.remoteEnable.smartGrid);
                await createStateMobileStart(adapter, path, currentDeviceState.remoteEnable.mobileStart);
                await createStateEstimatedEndTime(adapter, path, currentDeviceState);
                await createStateElapsedTime(adapter, path, currentDeviceState.elapsedTime);
                await createStateSpinningSpeed(
                    adapter,
                    `${path}.${currentDeviceState.spinningSpeed.key_localized}`,
                    currentDeviceState.spinningSpeed,
                    currentDeviceState.spinningSpeed.unit,
                );
                await createStateEcoFeedbackEnergy(adapter, path, currentDeviceState.ecoFeedback);
                await createStateEcoFeedbackWater(adapter, path, currentDeviceState.ecoFeedback);
                await createStateTargetTemperature(adapter, path, currentDeviceState.targetTemperature);
                break;
            case 2: // 2 = TUMBLE DRYER*
                // setup ecoFeedback channel for this device if needed
                await createChannelEcoFeedback(adapter, path);
                // states
                await createStateProgramID(
                    adapter,
                    `${path}.${currentDeviceState.ProgramID.key_localized}`,
                    currentDeviceState.ProgramID.value_localized,
                    currentDeviceState.ProgramID.value_raw,
                );
                await createStateProgramType(
                    adapter,
                    `${path}.${currentDeviceState.programType.key_localized}`,
                    currentDeviceState.programType.value_localized,
                    currentDeviceState.programType.value_raw,
                );
                await createStateProgramPhase(
                    adapter,
                    `${path}.${currentDeviceState.programPhase.key_localized}`,
                    currentDeviceState.programPhase.value_localized,
                    currentDeviceState.programPhase.value_raw,
                );
                await createStateRemainingTime(adapter, path, currentDeviceState.remainingTime);
                await createStateStartTime(adapter, path, currentDeviceState.startTime);
                await createStateSignalDoor(adapter, path, currentDeviceState.signalDoor);
                await createStateSignalInfo(adapter, path, currentDeviceState.signalInfo);
                await createStateFullRemoteControl(adapter, path, currentDeviceState.remoteEnable.fullRemoteControl);
                await createStateSmartGrid(adapter, path, currentDeviceState.remoteEnable.smartGrid);
                await createStateMobileStart(adapter, path, currentDeviceState.remoteEnable.mobileStart);
                await createStateEstimatedEndTime(adapter, path, currentDeviceState);
                await createStateElapsedTime(adapter, path, currentDeviceState.elapsedTime);
                await createStateDryingStep(
                    adapter,
                    `${path}.${currentDeviceState.dryingStep.key_localized}`,
                    currentDeviceState.dryingStep.value_localized,
                    currentDeviceState.dryingStep.value_raw,
                );
                await createStateEcoFeedbackEnergy(adapter, path, currentDeviceState.ecoFeedback);
                await createStateTargetTemperature(adapter, path, currentDeviceState.targetTemperature);
                break;
            case 24: // 24 = WASHER DRYER*
                // setup ecoFeedback channel for this device if needed
                await createChannelEcoFeedback(adapter, path);
                // states
                await createStateProgramID(
                    adapter,
                    `${path}.${currentDeviceState.ProgramID.key_localized}`,
                    currentDeviceState.ProgramID.value_localized,
                    currentDeviceState.ProgramID.value_raw,
                );
                await createStateProgramType(
                    adapter,
                    `${path}.${currentDeviceState.programType.key_localized}`,
                    currentDeviceState.programType.value_localized,
                    currentDeviceState.programType.value_raw,
                );
                await createStateProgramPhase(
                    adapter,
                    `${path}.${currentDeviceState.programPhase.key_localized}`,
                    currentDeviceState.programPhase.value_localized,
                    currentDeviceState.programPhase.value_raw,
                );
                await createStateRemainingTime(adapter, path, currentDeviceState.remainingTime);
                await createStateSignalDoor(adapter, path, currentDeviceState.signalDoor);
                await createStateStartTime(adapter, path, currentDeviceState.startTime);
                await createStateSignalInfo(adapter, path, currentDeviceState.signalInfo);
                await createStateFullRemoteControl(adapter, path, currentDeviceState.remoteEnable.fullRemoteControl);
                await createStateSmartGrid(adapter, path, currentDeviceState.remoteEnable.smartGrid);
                await createStateMobileStart(adapter, path, currentDeviceState.remoteEnable.mobileStart);
                await createStateEstimatedEndTime(adapter, path, currentDeviceState);
                await createStateElapsedTime(adapter, path, currentDeviceState.elapsedTime);
                await createStateSpinningSpeed(
                    adapter,
                    `${path}.${currentDeviceState.spinningSpeed.key_localized}`,
                    currentDeviceState.spinningSpeed,
                    currentDeviceState.spinningSpeed.unit,
                );
                await createStateDryingStep(
                    adapter,
                    `${path}.${currentDeviceState.dryingStep.key_localized}`,
                    currentDeviceState.dryingStep.value_localized,
                    currentDeviceState.dryingStep.value_raw,
                );
                await createStateEcoFeedbackEnergy(adapter, path, currentDeviceState.ecoFeedback);
                await createStateEcoFeedbackWater(adapter, path, currentDeviceState.ecoFeedback);
                await createStateTargetTemperature(adapter, path, currentDeviceState.targetTemperature);
                break;
            case 7: // 7 = DISHWASHER*
            case 8: // 8 = DISHWASHER SEMI-PROF
                // setup ecoFeedback channel for this device if needed
                await createChannelEcoFeedback(adapter, path);
                // states
                await createStateProgramID(
                    adapter,
                    `${path}.${currentDeviceState.ProgramID.key_localized}`,
                    currentDeviceState.ProgramID.value_localized,
                    currentDeviceState.ProgramID.value_raw,
                );
                await createStateProgramType(
                    adapter,
                    `${path}.${currentDeviceState.programType.key_localized}`,
                    currentDeviceState.programType.value_localized,
                    currentDeviceState.programType.value_raw,
                );
                await createStateProgramPhase(
                    adapter,
                    `${path}.${currentDeviceState.programPhase.key_localized}`,
                    currentDeviceState.programPhase.value_localized,
                    currentDeviceState.programPhase.value_raw,
                );
                await createStateRemainingTime(adapter, path, currentDeviceState.remainingTime);
                await createStateStartTime(adapter, path, currentDeviceState.startTime);
                await createStateSignalInfo(adapter, path, currentDeviceState.signalInfo);
                await createStateSignalDoor(adapter, path, currentDeviceState.signalDoor);
                await createStateFullRemoteControl(adapter, path, currentDeviceState.remoteEnable.fullRemoteControl);
                await createStateSmartGrid(adapter, path, currentDeviceState.remoteEnable.smartGrid);
                await createStateMobileStart(adapter, path, currentDeviceState.remoteEnable.mobileStart);
                await createStateEstimatedEndTime(adapter, path, currentDeviceState);
                await createStateElapsedTime(adapter, path, currentDeviceState.elapsedTime);
                await createStateEcoFeedbackEnergy(adapter, path, currentDeviceState.ecoFeedback);
                await createStateEcoFeedbackWater(adapter, path, currentDeviceState.ecoFeedback);
                break;
            case 12: // 12 = OVEN*
                await createStateProgramID(
                    adapter,
                    `${path}.${currentDeviceState.ProgramID.key_localized}`,
                    currentDeviceState.ProgramID.value_localized,
                    currentDeviceState.ProgramID.value_raw,
                );
                await createStateProgramType(
                    adapter,
                    `${path}.${currentDeviceState.programType.key_localized}`,
                    currentDeviceState.programType.value_localized,
                    currentDeviceState.programType.value_raw,
                );
                await createStateProgramPhase(
                    adapter,
                    `${path}.${currentDeviceState.programPhase.key_localized}`,
                    currentDeviceState.programPhase.value_localized,
                    currentDeviceState.programPhase.value_raw,
                );
                await createStateRemainingTime(adapter, path, currentDeviceState.remainingTime);
                await createStateStartTime(adapter, path, currentDeviceState.startTime);
                await createStateSignalInfo(adapter, path, currentDeviceState.signalInfo);
                await createStateSignalDoor(adapter, path, currentDeviceState.signalDoor);
                await createStateFullRemoteControl(adapter, path, currentDeviceState.remoteEnable.fullRemoteControl);
                await createStateSmartGrid(adapter, path, currentDeviceState.remoteEnable.smartGrid);
                await createStateMobileStart(adapter, path, currentDeviceState.remoteEnable.mobileStart);
                await createStateEstimatedEndTime(adapter, path, currentDeviceState);
                await createStateElapsedTime(adapter, path, currentDeviceState.elapsedTime);
                await createStateTemperature(adapter, path, currentDeviceState.temperature);
                await createStateTargetTemperature(adapter, path, currentDeviceState.targetTemperature);
                break;
            case 13: // 13 = OVEN Microwave*
            case 15: // 15 = STEAM OVEN*
            case 16: // 16 = MICROWAVE*
            case 31: // 31 = STEAM OVEN COMBINATION*
            case 45: // 45 = STEAM OVEN MICROWAVE COMBINATION*
            case 67: // 67 = DIALOG OVEN*
                await createStateProgramID(
                    adapter,
                    `${path}.${currentDeviceState.ProgramID.key_localized}`,
                    currentDeviceState.ProgramID.value_localized,
                    currentDeviceState.ProgramID.value_raw,
                );
                await createStateProgramType(
                    adapter,
                    `${path}.${currentDeviceState.programType.key_localized}`,
                    currentDeviceState.programType.value_localized,
                    currentDeviceState.programType.value_raw,
                );
                await createStateProgramPhase(
                    adapter,
                    `${path}.${currentDeviceState.programPhase.key_localized}`,
                    currentDeviceState.programPhase.value_localized,
                    currentDeviceState.programPhase.value_raw,
                );
                await createStateRemainingTime(adapter, path, currentDeviceState.remainingTime);
                await createStateStartTime(adapter, path, currentDeviceState.startTime);
                await createStateSignalInfo(adapter, path, currentDeviceState.signalInfo);
                await createStateSignalDoor(adapter, path, currentDeviceState.signalDoor);
                await createStateFullRemoteControl(adapter, path, currentDeviceState.remoteEnable.fullRemoteControl);
                await createStateSmartGrid(adapter, path, currentDeviceState.remoteEnable.smartGrid);
                await createStateMobileStart(adapter, path, currentDeviceState.remoteEnable.mobileStart);
                await createStateEstimatedEndTime(adapter, path, currentDeviceState);
                await createStateElapsedTime(adapter, path, currentDeviceState.elapsedTime);
                await createStateTemperature(adapter, path, currentDeviceState.temperature);
                await createStateTargetTemperature(adapter, path, currentDeviceState.targetTemperature);
                break;
            case 14: // 14 = HOB HIGHLIGHT*
            case 27: // 27 = HOB INDUCTION*
                await createStatePlateStep(adapter, path, currentDeviceState.plateStep);
                break;
            case 17: // 17 = COFFEE SYSTEM*
                await createStateProgramID(
                    adapter,
                    `${path}.${currentDeviceState.ProgramID.key_localized}`,
                    currentDeviceState.ProgramID.value_localized,
                    currentDeviceState.ProgramID.value_raw,
                );
                await createStateProgramPhase(
                    adapter,
                    `${path}.${currentDeviceState.programPhase.key_localized}`,
                    currentDeviceState.programPhase.value_localized,
                    currentDeviceState.programPhase.value_raw,
                );
                await createStateSignalInfo(adapter, path, currentDeviceState.signalInfo);
                await createStateFullRemoteControl(adapter, path, currentDeviceState.remoteEnable.fullRemoteControl);
                await createStateSmartGrid(adapter, path, currentDeviceState.remoteEnable.smartGrid);
                await createStateMobileStart(adapter, path, currentDeviceState.remoteEnable.mobileStart);
                break;
            case 18: // 18 = HOOD*
                // States
                await createStateSignalInfo(adapter, path, currentDeviceState.signalInfo);
                await createStateFullRemoteControl(adapter, path, currentDeviceState.remoteEnable.fullRemoteControl);
                await createStateSmartGrid(adapter, path, currentDeviceState.remoteEnable.smartGrid);
                await createStateMobileStart(adapter, path, currentDeviceState.remoteEnable.mobileStart);
                await createVentilationStepSwitch(adapter, path, currentDeviceState.ventilationStep.value_raw);
                // colors
                break;
            case 19: // 19 = FRIDGE*
                await createStateSignalInfo(adapter, path, currentDeviceState.signalInfo);
                await createStateSignalDoor(adapter, path, currentDeviceState.signalDoor);
                await createStateFullRemoteControl(adapter, path, currentDeviceState.remoteEnable.fullRemoteControl);
                await createStateSmartGrid(adapter, path, currentDeviceState.remoteEnable.smartGrid);
                await createStateMobileStart(adapter, path, currentDeviceState.remoteEnable.mobileStart);
                await createStateTemperature(adapter, path, currentDeviceState.temperature);
                await createStateTargetTemperature(adapter, path, currentDeviceState.targetTemperature);
                break;
            case 20: // 20 = FREEZER*
                await createStateSignalInfo(adapter, path, currentDeviceState.signalInfo);
                await createStateSignalDoor(adapter, path, currentDeviceState.signalDoor);
                await createStateFullRemoteControl(adapter, path, currentDeviceState.remoteEnable.fullRemoteControl);
                await createStateSmartGrid(adapter, path, currentDeviceState.remoteEnable.smartGrid);
                await createStateMobileStart(adapter, path, currentDeviceState.remoteEnable.mobileStart);
                await createStateTemperature(adapter, path, currentDeviceState.temperature);
                await createStateTargetTemperature(adapter, path, currentDeviceState.targetTemperature);
                break;
            case 21: // 21 = FRIDGE-/FREEZER COMBINATION*
                await createStateSignalInfo(adapter, path, currentDeviceState.signalInfo);
                await createStateSignalDoor(adapter, path, currentDeviceState.signalDoor);
                await createStateFullRemoteControl(adapter, path, currentDeviceState.remoteEnable.fullRemoteControl);
                await createStateSmartGrid(adapter, path, currentDeviceState.remoteEnable.smartGrid);
                await createStateMobileStart(adapter, path, currentDeviceState.remoteEnable.mobileStart);
                await createStateTemperature(adapter, path, currentDeviceState.temperature);
                await createStateTargetTemperature(adapter, path, currentDeviceState.targetTemperature);
                break;
            case 32: // 32 = WINE CABINET*
            case 33: // 33 = WINE CONDITIONING UNIT
            case 34: // 34 = WINE STORAGE CONDITIONING UNIT
                await createStateSignalInfo(adapter, path, currentDeviceState.signalInfo);
                await createStateSignalDoor(adapter, path, currentDeviceState.signalDoor);
                await createStateFullRemoteControl(adapter, path, currentDeviceState.remoteEnable.fullRemoteControl);
                await createStateSmartGrid(adapter, path, currentDeviceState.remoteEnable.smartGrid);
                await createStateMobileStart(adapter, path, currentDeviceState.remoteEnable.mobileStart);
                await createStateTemperature(adapter, path, currentDeviceState.temperature);
                await createStateTargetTemperature(adapter, path, currentDeviceState.targetTemperature);
                break;
            case 28: // 28 = HOB GAS
                break;
            case 39: // 39 = DOUBLE OVEN
                break;
            case 40: // 40 = DOUBLE STEAM OVEN
                break;
            case 41: // 41 = DOUBLE STEAM OVEN COMBINATION
                break;
            case 42: // 42 = DOUBLE MICROWAVE
                break;
            case 43: // 43 = DOUBLE MICROWAVE OVEN
                break;
            case 68: // 68 = WINE CABINET FREEZER COMBINATION
                await createStateSignalInfo(adapter, path, currentDeviceState.signalInfo);
                await createStateFullRemoteControl(adapter, path, currentDeviceState.remoteEnable.fullRemoteControl);
                await createStateSmartGrid(adapter, path, currentDeviceState.remoteEnable.smartGrid);
                await createStateMobileStart(adapter, path, currentDeviceState.remoteEnable.mobileStart);
                await createStateTemperature(adapter, path, currentDeviceState.temperature);
                await createStateTargetTemperature(adapter, path, currentDeviceState.targetTemperature);
                break;
            case 23: // 23 = VACUUM CLEANER, AUTOMATIC ROBOTIC VACUUM CLEANER*
                await createStateBatteryLevel(adapter, path, currentDeviceState.batteryLevel);
                // await createGroupRooms(adapter,  path);
                break;
            case 25: // 25 = DISH WARMER*
                await createStateProgramID(
                    adapter,
                    `${path}.${currentDeviceState.ProgramID.key_localized}`,
                    currentDeviceState.ProgramID.value_localized,
                    currentDeviceState.ProgramID.value_raw,
                );
                await createStateProgramPhase(
                    adapter,
                    `${path}.${currentDeviceState.programPhase.key_localized}`,
                    currentDeviceState.programPhase.value_localized,
                    currentDeviceState.programPhase.value_raw,
                );
                await createStateRemainingTime(adapter, path, currentDeviceState.remainingTime);
                await createStateTargetTemperature(adapter, path, currentDeviceState.targetTemperature);
                await createStateSignalDoor(adapter, path, currentDeviceState.signalDoor);
                await createStateTemperature(adapter, path, currentDeviceState.temperature);
                await createStateSignalInfo(adapter, path, currentDeviceState.signalInfo);
                break;
            case 48: // 48 = VACUUM DRAWER
                break;
            case 74: // 74 = Hob with vapour extraction
                // States
                await createStatePlateStep(adapter, path, currentDeviceState.plateStep);
                await createStateSignalFailure(adapter, path, currentDeviceState.signalFailure);
                await createStateFullRemoteControl(adapter, path, currentDeviceState.remoteEnable.fullRemoteControl);
                await createStateSmartGrid(adapter, path, currentDeviceState.remoteEnable.smartGrid);
                await createStateMobileStart(adapter, path, currentDeviceState.remoteEnable.mobileStart);
                await createVentilationStepSwitch(adapter, path, currentDeviceState.ventilationStep.value_raw);
                // colors
                break;
        }
    } catch (err) {
        adapter.log.error(`[addMieleDeviceState]: ${err.message}, Stacktrace: ${err.stack}`);
    }
}

/**
 * addDeviceNicknameAction
 *
 * add the nickname action to the device tree
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param mieleDevice {object} ident data of the device
 */
async function addDeviceNicknameAction(adapter, path, mieleDevice) {
    // addDeviceNicknameAction - suitable for each and every device
    await createRWState(
        adapter,
        `${path}.ACTIONS.Nickname`,
        'Nickname of your device. Can be edited in Miele APP or here!',
        mieleDevice.ident.deviceName === '' ? mieleDevice.ident.type.value_localized : mieleDevice.ident.deviceName,
        'string',
        'text',
        null,
    );
}

/**
 * createStateDeviceMainState
 *
 * create the state that shows the main state for this Device.
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param value {string} value to set to the data point
 * @param value_raw {number} value to set to the raw-data point
 */
async function createStateDeviceMainState(adapter, path, value, value_raw) {
    await createROState(adapter, `${path}_raw`, 'Main state of the Device (raw-value)', value_raw, 'number', 'value');
    await createString(adapter, path, 'Main state of the Device', value);
}

/**
 * createStateSignalFailure
 *
 * create the state that shows whether a failure message is active for this Device.
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param value {boolean} value to set to the data point
 */
async function createStateSignalFailure(adapter, path, value) {
    await createROState(
        adapter,
        `${path}.signalFailure`,
        'Indicates whether a failure message is active for this Device.',
        value,
        'boolean',
        'indicator',
    );
}

/**
 * createStateSignalInUse
 *
 * create the state that shows whether the device is connected to WLAN or Gateway.
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param value {boolean} value to set to the data point
 */
async function createStateSignalInUse(adapter, path, value) {
    await createROState(
        adapter,
        `${path}.signalInUse`,
        'Indicates whether the device is in use or switched off.',
        value,
        'boolean',
        'indicator',
    );
}

/**
 * createStateSignalInfo
 *
 * create the state that shows whether a notification is active for this Device
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param value {boolean} value to set to the data point
 */
async function createStateSignalInfo(adapter, path, value) {
    await createROState(
        adapter,
        `${path}.signalInfo`,
        'Indicates whether a notification is active for this Device.',
        value,
        'boolean',
        'indicator',
    );
}

/**
 * createStateConnected
 *
 * create the state that shows whether the device is connected to WLAN or Gateway.
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param value {boolean} value to set to the data point
 */
async function createStateConnected(adapter, path, value) {
    await createROState(
        adapter,
        `${path}.Connected`,
        'Indicates whether the device is connected to WLAN or Gateway.',
        value,
        'boolean',
        'indicator.reachable',
    );
}

/**
 * createStateSmartGrid
 *
 * create the state that shows whether the device is set to Smart Grid mode
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param value {boolean} value to set to the data point
 */
async function createStateSmartGrid(adapter, path, value) {
    await createROState(
        adapter,
        `${path}.smartGrid`,
        'Indicates whether the device is set to Smart Grid mode',
        value,
        'boolean',
        'indicator',
    );
}

/**
 * createStateMobileStart
 *
 * create the state that shows whether the device is set to Smart Grid mode
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param value {boolean} value to set to the data point
 */
async function createStateMobileStart(adapter, path, value) {
    await createROState(
        adapter,
        `${path}.mobileStart`,
        'Indicates whether the device supports the Mobile Start option.',
        value,
        'boolean',
        'indicator',
    );
}

/**
 * createStateFullRemoteControl
 *
 * create the state that shows whether the device can be controlled from remote.
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param value {boolean} value to set to the data point
 */
async function createStateFullRemoteControl(adapter, path, value) {
    await createROState(
        adapter,
        `${path}.fullRemoteControl`,
        'Indicates whether the device can be controlled from remote.',
        value,
        'boolean',
        'indicator',
    );
}

/**
 * createStateSignalDoor
 *
 * create the state that shows whether a door-open message is active for this Device
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param value {boolean} value to set to the data point
 */
async function createStateSignalDoor(adapter, path, value) {
    await createROState(
        adapter,
        `${path}.signalDoor`,
        'Indicates whether a door-open message is active for this Device.',
        value,
        'boolean',
        'indicator',
    );
}

/**
 * addPrograms
 *
 * adds the available programs for the given device to the object tree
 *
 * @param adapter link to the adapter instance
 * @param auth Object with authorization information for Miele API
 * @param device The device to query the programs for
 */
async function addPrograms(adapter, auth, device) {
    await sendAPIRequest(
        adapter,
        auth,
        mieleConst.ENDPOINT_PROGRAMS.replace('DEVICEID', knownDevices[device].API_ID).replace(
            'LANG',
            adapter.config.locale,
        ),
        'GET',
        '',
    )
        .then(programs => {
            adapter.log.debug(`addPrograms: available Progs: ${JSON.stringify(programs)}`);
            if (Object.keys(programs).length > 0) {
                knownDevices[device].programs = [];
                knownDevices[device].programs = programs;
                adapter.log.debug(`addPrograms: knownDevices: ${JSON.stringify(knownDevices)}`);
                for (const prog in programs) {
                    createOrExtendObject(
                        adapter,
                        `${device}.ACTIONS.${programs[prog].programId}`,
                        {
                            type: 'state',
                            common: {
                                name: programs[prog].program,
                                read: true,
                                write: true,
                                role: 'button',
                                type: 'boolean',
                            },
                            native: { parameters: programs.parameters },
                        },
                        true,
                    );
                }
            } else {
                adapter.log.info(
                    `Sorry. No programs to add for device: ${knownDevices[device].name} (${device}). Reason: No programs have been returned by the API for this device.`,
                );
                knownDevices[device].programs = {};
            }
        })
        .catch(err => {
            adapter.log.info(
                `Sorry. No programs to add for device: ${knownDevices[device].name} (${device}). Reason: ${err}`,
            );
            knownDevices[device].programs = {};
        });
}

/**
 * createStateProgramID
 *
 * create the state that shows the main state for this Device.
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param value {string} value to set to the data point
 * @param value_raw {number} value to set to the raw-data point
 */
async function createStateProgramID(adapter, path, value, value_raw) {
    await createROState(adapter, `${path}_raw`, 'ID of the running Program (raw-value)', value_raw, 'number', 'value');
    await createROState(adapter, path, 'Name of the running Program', value, 'string', 'text');
}

/**
 * createStateProgramType
 *
 * create the state that shows the Program type of the running Program
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param value {string} value to set to the data point
 * @param value_raw {number} value to set to the raw-data point
 */
async function createStateProgramType(adapter, path, value, value_raw) {
    await createROState(
        adapter,
        `${path}_raw`,
        'Program type of the running Program (raw-value)',
        value_raw,
        'number',
        'value',
    );
    await createROState(adapter, path, 'Program type of the running Program', value, 'string', 'text');
}

/**
 * createStateProgramPhase
 *
 * create the state that shows the Phase of the running program
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param value {string} value to set to the data point
 * @param value_raw {number} value to set to the raw-data point
 */
async function createStateProgramPhase(adapter, path, value, value_raw) {
    await createROState(
        adapter,
        `${path}_raw`,
        'Phase of the running program (raw-value)',
        value_raw,
        'number',
        'value',
    );
    await createROState(adapter, path, 'Phase of the running program', value, 'string', 'text');
}

/**
 * createStateDryingStep
 *
 * create the state that shows the
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param value {string} value to set to the data point
 * @param value_raw {number} value to set to the raw-data point
 */
async function createStateDryingStep(adapter, path, value, value_raw) {
    await createROState(
        adapter,
        `${path}_raw`,
        'The dryingStep object represents the selected drying step of a tumble dryer or a washer-dryer combination. (raw-value)',
        value_raw,
        'number',
        'value',
    );
    await createROState(
        adapter,
        path,
        'The dryingStep object represents the selected drying step of a tumble dryer or a washer-dryer combination.',
        value,
        'string',
        'text',
    );
}

/**
 * createStateEstimatedEndTime
 *
 * create the state that shows the estimated ending time of the current running program
 *
 * @param adapter  link to the adapter instance
 * @param path path where the data point is going to be created
 * @param currentDeviceState array that contains the remaining time in format [hours, minutes]
 * @param currentDeviceState.remainingTime array that contains the remaining time in format [hours, minutes]
 * @param currentDeviceState.status  current state of the device
 * @param currentDeviceState.status.value_raw current state of the device
 */
async function createStateEstimatedEndTime(adapter, path, currentDeviceState) {
    if (
        parseInt(currentDeviceState.status.value_raw) < 2 ||
        currentDeviceState.remainingTime[0] + currentDeviceState.remainingTime[1] === 0
    ) {
        adapter.log.debug(`No EstimatedEndTime to show for device ${knownDevices[path].name} (${path})!`);
        await createROState(
            adapter,
            `${path}.estimatedEndTime`,
            'The EstimatedEndTime is the current time plus remaining time of the running program.',
            '',
            'string',
            'text',
        );
    } else {
        const now = new Date();
        const estimatedEndTime = new Date();
        estimatedEndTime.setMinutes(
            now.getMinutes() + (currentDeviceState.remainingTime[0] * 60 + currentDeviceState.remainingTime[1] * 1),
        );
        const timeToShow = estimatedEndTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        await createROState(
            adapter,
            `${path}.estimatedEndTime`,
            'The EstimatedEndTime is the current time plus remaining time of the running program.',
            timeToShow,
            'string',
            'text',
        );
    }
}

/**
 * createStateRemainingTime
 *
 * create the state that shows the remaining time of the running program
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param remainingTime {object} array value to set to the data point
 */
async function createStateRemainingTime(adapter, path, remainingTime) {
    await createTime(
        adapter,
        `${path}.remainingTime`,
        'The RemainingTime equals the relative remaining time',
        remainingTime,
        'text',
    );
}

/**
 * createStateStartTime
 *
 * create the state that shows the start time of the running program
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param startTime {object} array value to set to the data point
 */
async function createStateStartTime(adapter, path, startTime) {
    await createTime(
        adapter,
        `${path}.ACTIONS.startTime`,
        'The StartTime equals the relative starting time',
        startTime,
        'value',
    );
}

/**
 * createStateElapsedTime
 *
 * create the state that shows the elapsed time of the running program
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param value {object} array value that represents a time value to set to the data point
 */
async function createStateElapsedTime(adapter, path, value) {
    await createTime(
        adapter,
        `${path}.elapsedTime`,
        'ElapsedTime since program start (only present for certain devices)',
        value,
        '',
    );
}

/**
 * createStateTemperature
 *
 * create the state that shows information about one or multiple temperatures of the device.
 * API returns 1 to 3 values depending on the device
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param valueObj {object} array valueObj to set to the data point
 */
async function createStateTemperature(adapter, path, valueObj) {
    for (let n = 0; n < valueObj.length; n++) {
        if (
            valueObj[n].value_raw === -32768 ||
            valueObj[n].value_raw === null ||
            valueObj[n].value_raw === 'null' ||
            valueObj[n].value_raw === 'undefined'
        ) {
            return;
        }
        const unit = valueObj[n].unit === 'Celsius' ? '°C' : '°F';
        createOrExtendObject(
            adapter,
            `${path}.temperatureZone-${n + 1}`,
            {
                type: 'state',
                common: {
                    name: `The current temperature of zone ${n + 1}.`,
                    read: true,
                    write: false,
                    type: 'number',
                    unit: unit,
                    role: 'value.temperature',
                },
                native: {},
            },
            valueObj[n].value_localized,
        );
    }
}

/**
 * createStateTargetTemperature
 *
 * create the state that shows information about one or multiple target temperatures of the process.
 * API returns 0 to 3 values depending on the device
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param valueObj {object} array valueObj to set to the data point
 */
async function createStateTargetTemperature(adapter, path, valueObj) {
    for (let n = 0; n < valueObj.length; n++) {
        if (
            valueObj[n].value_raw === -32768 ||
            valueObj[n].value_raw === null ||
            valueObj[n].value_raw === 'null' ||
            valueObj[n].value_raw === 'undefined'
        ) {
            return;
        }
        const unit = valueObj[n].unit === 'Celsius' ? '°C' : '°F';
        createOrExtendObject(
            adapter,
            `${path}.ACTIONS.targetTemperatureZone-${n + 1}`,
            {
                type: 'state',
                common: {
                    name: `The target temperature of zone ${n + 1}.`,
                    read: true,
                    write: true,
                    type: 'number',
                    unit: unit,
                    role: 'value.temperature',
                },
                native: {},
            },
            valueObj[n].value_localized,
        );
    }
}

/**
 * updateStateTargetTemperature
 *
 * create the state that shows information about one or multiple target temperatures of the process.
 * API returns 1 to 3 values depending on the device
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param valueObj {object} array valueObj to set to the data point
 */
async function updateStateTargetTemperature(adapter, path, valueObj) {
    for (let n = 0; n < valueObj.length; n++) {
        if (
            valueObj[n].value_raw === -32768 ||
            valueObj[n].value_raw === null ||
            valueObj[n].value_raw === 'null' ||
            valueObj[n].value_raw === 'undefined'
        ) {
            return;
        }
        adapter.getObject(`${path}.ACTIONS.targetTemperatureZone-${valueObj[n].zone}`, function (err, oldObj) {
            if (!err && oldObj) {
                if (
                    `The target temperature of zone ${valueObj[n].zone} (${valueObj[n].min} to ${valueObj[n].max}).` !==
                    oldObj.common.name
                ) {
                    adapter.extendObject(`${path}.ACTIONS.targetTemperatureZone-${valueObj[n].zone}`, {
                        common: {
                            name: `The target temperature of zone ${valueObj[n].zone} (${valueObj[n].min} to ${valueObj[n].max}).`,
                            min: valueObj[n].min,
                            max: valueObj[n].max,
                        },
                        native: {},
                    });
                }
            }
        });
    }
}

/**
 * createStatePlateStep
 *
 * create the state that shows the selected cooking zone levels for a hob
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param value {object} array value to set to the data point
 */
async function createStatePlateStep(adapter, path, value) {
    for (const n in value) {
        const MyPath = `${path}.PlateStepZone-${n}`;
        await createROState(
            adapter,
            MyPath,
            'The plateStep object represents the selected cooking zone levels for a hob (localized value).',
            value[n].value_localized,
            'string',
            'text',
        );
        await createROState(
            adapter,
            `${MyPath}_raw`,
            'The plateStep object represents the selected cooking zone levels for a hob (raw value).',
            Number.parseInt(value[n].value_raw),
            'number',
            'level',
        );
    }
}

/**
 * createStateBatteryLevel
 *
 * create the state that shows the charging level of a builtin battery as a percentage value between 0 .. 100
 * NEW API 1.0.4
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param value {number} value to set to the data point
 */
async function createStateBatteryLevel(adapter, path, value) {
    await createNumber(
        adapter,
        `${path}.batteryLevel`,
        'The batteryLevel object returns the charging level of a builtin battery as a percentage value between 0 .. 100',
        value == null ? 0 : value,
        '%',
        'value',
    );
}

/**
 * createStateEcoFeedbackWater
 *
 * create the states that show
 * NEW API 1.0.4
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param ecoFeedback {object} value to set to the data point
 */
async function createStateEcoFeedbackWater(adapter, path, ecoFeedback) {
    //adapter.log.debug(`createStateEcoFeedbackWater: Path[${path}], setup: [${setup}], path: [${path}], value: [${JSON.stringify(ecoFeedback)}]`);
    await createNumber(
        adapter,
        `${path}.EcoFeedback.currentWaterConsumption`,
        'The amount of water used by the current running program up to the present moment.',
        ecoFeedback === null ? 0 : ecoFeedback.currentWaterConsumption.value.valueOf() * 1,
        ecoFeedback === null ? 'l' : ecoFeedback.currentWaterConsumption.unit,
        'value',
    );
    await createNumber(
        adapter,
        `${path}.EcoFeedback.waterForecast`,
        'The relative water usage for the selected program from 0 to 100.',
        ecoFeedback === null ? 0 : ecoFeedback.waterForecast * 100,
        '%',
        'value',
    );
}

/**
 * createStateEcoFeedbackEnergy
 *
 * create the states that show
 * NEW API 1.0.4
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param ecoFeedback {object} value to set to the data point
 */
async function createStateEcoFeedbackEnergy(adapter, path, ecoFeedback) {
    await createNumber(
        adapter,
        `${path}.EcoFeedback.currentEnergyConsumption`,
        'The amount of energy used by the current running program up to the present moment.',
        ecoFeedback === null ? 0 : ecoFeedback.currentEnergyConsumption.value.valueOf() * 1,
        ecoFeedback === null ? 'kWh' : ecoFeedback.currentEnergyConsumption.unit,
        'value.power.consumption',
    );
    await createNumber(
        adapter,
        `${path}.EcoFeedback.EnergyForecast`,
        'The relative energy usage for the selected program from 0 to 100.',
        ecoFeedback === null ? 0 : ecoFeedback.energyForecast * 100,
        '%',
        'value',
    );
}

/**
 * createStateSpinningSpeed
 *
 * create the states that show
 *
 * @param adapter               {object} link to the adapter instance
 * @param path                  {string} path where the data point is going to be created
 * @param value                 {object} values to set to the data point
 * @param value.value_localized {string} value to set to the data point
 * @param value.value_raw       {string} raw number value to set to the data point
 * @param unit                  {string} unit the value is in
 */
async function createStateSpinningSpeed(adapter, path, value, unit) {
    await createROState(
        adapter,
        path,
        'Spinning speed of a washing machine (localized value).',
        value.value_localized,
        'string',
        'text',
    );
    await createNumber(
        adapter,
        `${path}_raw`,
        'Spinning speed of a washing machine (raw value).',
        Number.parseInt(value.value_raw),
        unit,
        'value',
    );
}

/**
 * createChannelActions
 *
 * create the channel for Actions
 *
 * @param adapter link to the adapter instance
 * @param message the message object as received from miele
 */
module.exports.splitMieleActionsMessage = async function (adapter, message) {
    for (const [device, actions] of Object.entries(message)) {
        adapter.log.debug(`Device ${device}: Value ${JSON.stringify(actions)} | typeof value ${typeof actions}`);
        if (typeof knownDevices[device] === 'undefined') {
            adapter.log.debug(`Device [${device}] is currently unknown - skipping creating actions on it.`);
        } else {
            adapter.log.debug(`KnownDevice before updating actions on it: ${JSON.stringify(knownDevices[device])}`);
            await createDeviceActions(adapter, device, actions);
        }
    }
};

/**
 * processes actions message for each device
 *
 * @param adapter Link to the adapter instance
 * @param device Name (mostly serial) of the current device in the device tree
 * @param actions actions object as received from miele, but splitted into single devices
 * @returns
 */
async function createDeviceActions(adapter, device, actions) {
    await createChannelActions(adapter, device);
    knownDevices[device].actions = actions;
    try {
        switch (knownDevices[device].deviceType) {
            case 1: // 1 = WASHING MACHINE*
            case 2: // 2 = TUMBLE DRYER*
            case 24: // 24 = WASHER DRYER*
                // Actions
                await addPowerSwitch(adapter, device, !actions.powerOn);
                await addStartButton(adapter, device, true);
                await addStopButton(adapter, device, true);
                await addLightSwitch(adapter, device, actions.light.includes(mieleConst.LIGHT_OFF));
                await updateStateTargetTemperature(adapter, device, actions.targetTemperature);
                break;
            case 7: // 7 = DISHWASHER*
            case 8: // 8 = DISHWASHER SEMI-PROF
                // Actions
                await addPowerSwitch(adapter, device, !actions.powerOn);
                await addStartButton(adapter, device, true);
                await addStopButton(adapter, device, true);
                await addPauseButton(adapter, device, true);
                await addLightSwitch(adapter, device, actions.light.includes(mieleConst.LIGHT_OFF));
                break;
            case 12: // 12 = OVEN*
                // Actions
                await addStopButton(adapter, device, true);
                await addLightSwitch(adapter, device, actions.light.includes(mieleConst.LIGHT_OFF));
                await updateStateTargetTemperature(adapter, device, actions.targetTemperature);
                break;
            case 13: // 13 = OVEN Microwave*
            case 15: // 15 = STEAM OVEN*
            case 16: // 16 = MICROWAVE*
            case 31: // 31 = STEAM OVEN COMBINATION*
            case 45: // 45 = STEAM OVEN MICROWAVE COMBINATION*
            case 67: // 67 = DIALOG OVEN*
                // Actions
                await addPowerSwitch(adapter, device, !actions.powerOn);
                await addStopButton(adapter, device, true);
                await addLightSwitch(adapter, device, actions.light.includes(mieleConst.LIGHT_OFF));
                await updateStateTargetTemperature(adapter, device, actions.targetTemperature);
                break;
            case 14: // 14 = HOB HIGHLIGHT*
            case 27: // 27 = HOB INDUCTION*
                break;
            case 17: // 17 = COFFEE SYSTEM*
                // Actions
                await addPowerSwitch(adapter, device, !actions.powerOn);
                await addLightSwitch(adapter, device, actions.light.includes(mieleConst.LIGHT_OFF));
                break;
            case 18: // 18 = HOOD*
                // Actions
                await addPowerSwitch(adapter, device, !actions.powerOn);
                await addStopButton(adapter, device, true);
                await addLightSwitch(adapter, device, actions.light.includes(mieleConst.LIGHT_OFF));
                await addColorsAction(adapter, device);
                // colors
                break;
            case 19: // 19 = FRIDGE*
                // Actions
                await addSuperCoolingSwitch(
                    adapter,
                    device,
                    actions.processAction.includes(mieleConst.STOP_SUPERCOOLING),
                );
                await updateStateTargetTemperature(adapter, device, actions.targetTemperature);
                break;
            case 20: // 20 = FREEZER*
                // Actions
                await addSuperFreezingSwitch(
                    adapter,
                    device,
                    actions.processAction.includes(mieleConst.STOP_SUPERFREEZING),
                );
                await updateStateTargetTemperature(adapter, device, actions.targetTemperature);
                break;
            case 21: // 21 = FRIDGE-/FREEZER COMBINATION*
                // Actions
                await addSuperCoolingSwitch(
                    adapter,
                    device,
                    actions.processAction.includes(mieleConst.STOP_SUPERCOOLING),
                );
                await addSuperFreezingSwitch(
                    adapter,
                    device,
                    actions.processAction.includes(mieleConst.STOP_SUPERFREEZING),
                );
                await updateStateTargetTemperature(adapter, device, actions.targetTemperature);
                break;
            case 32: // 32 = WINE CABINET*
            case 33: // 33 = WINE CONDITIONING UNIT
            case 34: // 34 = WINE STORAGE CONDITIONING UNIT
                // Actions
                await addLightSwitch(adapter, device, actions.light.includes(mieleConst.LIGHT_OFF));
                await updateStateTargetTemperature(adapter, device, actions.targetTemperature);
                break;
            case 28: // 28 = HOB GAS
                break;
            case 39: // 39 = DOUBLE OVEN
                break;
            case 40: // 40 = DOUBLE STEAM OVEN
                break;
            case 41: // 41 = DOUBLE STEAM OVEN COMBINATION
                break;
            case 42: // 42 = DOUBLE MICROWAVE
                break;
            case 43: // 43 = DOUBLE MICROWAVE OVEN
                break;
            case 68: // 68 = WINE CABINET FREEZER COMBINATION
                // Actions
                await addSuperFreezingSwitch(
                    adapter,
                    device,
                    actions.processAction.includes(mieleConst.STOP_SUPERFREEZING),
                );
                await addLightSwitch(adapter, device, actions.light.includes(mieleConst.LIGHT_OFF));
                await addModeSwitch(adapter, device);
                await updateStateTargetTemperature(adapter, device, actions.targetTemperature);
                break;
            case 23: // 23 = VACUUM CLEANER, AUTOMATIC ROBOTIC VACUUM CLEANER*
                // Actions
                await addProgramIdAction(adapter, device);
                await addStartButton(adapter, device, true);
                await addStopButton(adapter, device, true);
                await addPauseButton(adapter, device, true);
                break;
            case 25: // 25 = DISH WARMER*
                // Actions
                await addProgramIdAction(adapter, device);
                await updateStateTargetTemperature(adapter, device, actions.targetTemperature);
                break;
            case 48: // 48 = VACUUM DRAWER
                break;
        }
    } catch (err) {
        adapter.log.warn(`createDeviceActions: ${err}`);
    }
    adapter.subscribeStates(`${device}.ACTIONS.*`);
}

/**
 * Function addProgramIdAction
 *
 * Adds programId action switch to the device tree
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the action button is going to be created
 */
async function addProgramIdAction(adapter, path) {
    createOrExtendObject(
        adapter,
        `${path}.ACTIONS.programId`,
        {
            type: 'state',
            common: {
                name: 'Program Id - to select a program. Values depend on your device. See Miele docs.',
                read: true,
                write: true,
                role: 'switch',
                type: 'number',
            },
            native: {},
        },
        0,
    );
}

/**
 * Function addModeSwitch
 *
 * Adds a Modes switch to the device tree and subscribes for changes to it
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the action button is going to be created
 */
async function addModeSwitch(adapter, path) {
    createOrExtendObject(
        adapter,
        `${path}.ACTIONS.Mode`,
        {
            type: 'state',
            common: {
                name: 'Modes switch of the device',
                read: true,
                write: true,
                role: 'switch',
                type: 'number',
                states: { Normal: 0, Sabbath: 1 },
            },
            native: {},
        },
        0,
    );
}

/**
 * Function addSuperCoolingSwitch
 *
 * Adds a SuperCooling switch to the device tree and subscribes for changes to it
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the action button is going to be created
 * @param isSupercooling {boolean} indicates whether the device is currently supercooling
 */
async function addSuperCoolingSwitch(adapter, path, isSupercooling) {
    createOrExtendObject(
        adapter,
        `${path}.ACTIONS.SuperCooling`,
        {
            type: 'state',
            common: {
                name: 'SuperCooling switch of the device',
                read: true,
                write: true,
                role: 'switch',
                type: 'boolean',
            },
            native: {},
        },
        isSupercooling,
    );
}

/**
 * Function addSuperFreezingSwitch
 *
 * Adds a SuperFreezing switch to the device tree and subscribes for changes to it
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the action button is going to be created
 * @param isSuperFreezing {boolean} indicates whether the device is currently super freezing
 */
async function addSuperFreezingSwitch(adapter, path, isSuperFreezing) {
    createOrExtendObject(
        adapter,
        `${path}.ACTIONS.SuperFreezing`,
        {
            type: 'state',
            common: {
                name: 'SuperFreezing switch of the device',
                read: true,
                write: true,
                role: 'switch',
                type: 'boolean',
            },
            native: {},
        },
        isSuperFreezing,
    );
}

/**
 * Function addColorsAction
 *
 * Adds colors action switch to the device tree
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the action button is going to be created
 */
async function addColorsAction(adapter, path) {
    createOrExtendObject(
        adapter,
        `${path}.ACTIONS.Color`,
        {
            type: 'state',
            common: {
                name: 'select the ambient light color of your device',
                read: true,
                write: true,
                role: 'switch',
                type: 'string',
                states: {
                    white: 'white',
                    blue: 'blue',
                    red: 'red',
                    yellow: 'yellow',
                    orange: 'orange',
                    green: 'green',
                    pink: 'pink',
                    purple: 'purple',
                    turquoise: 'turquoise',
                },
            },
            native: {},
        },
        'white',
    );
}

/**
 * createChannelActions
 *
 * create the channel for Actions
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 */
async function createChannelActions(adapter, path) {
    createOrExtendObject(
        adapter,
        `${path}.ACTIONS`,
        {
            type: 'channel',
            common: {
                name: 'Available actions for this device',
                read: true,
                write: false,
                icon: 'icons/cog.svg',
                type: 'object',
            },
            native: {},
        },
        null,
    );
    createOrExtendObject(
        adapter,
        `${path}.ACTIONS.LastActionResult`,
        {
            type: 'state',
            common: {
                name: 'Additional information on the execution of the last action',
                read: true,
                write: false,
                icon: 'icons/info.svg',
                type: 'string',
            },
            native: {},
        },
        '',
    );
}

/**
 *
 * @param adapter link to the adapter instance
 * @param path path where the state should be created
 * @param currentState current state of this state
 * @returns
 */
async function createVentilationStepSwitch(adapter, path, currentState) {
    await createRWState(
        adapter,
        `${path}.ACTIONS.VentilationStep`,
        'Ventilation step switch of the device',
        currentState,
        'number',
        'level',
        { 0: 'Off', 1: 'Level 1', 2: 'Level 2', 3: 'Level 3', 4: 'Level 4' },
    );
}

/**
 *
 * @param adapter link to the adapter instance
 * @param path path where the state should be created
 * @param currentState current state of this state
 * @returns
 */
async function addPowerSwitch(adapter, path, currentState) {
    await createRWState(
        adapter,
        `${path}.ACTIONS.Power`,
        'Main power switch of the device',
        currentState,
        'boolean',
        'switch.power',
        '',
    );
}

async function addStartButton(adapter, path, data) {
    createOrExtendObject(
        adapter,
        `${path}.ACTIONS.Start`,
        {
            type: 'state',
            common: {
                name: 'Starts the device if possible. Depends on prerequisites.',
                read: true,
                write: true,
                role: 'button',
                type: 'boolean',
            },
            native: { buttonType: 'button.start' },
        },
        data,
    );
}

async function addStopButton(adapter, path, data) {
    createOrExtendObject(
        adapter,
        `${path}.ACTIONS.Stop`,
        {
            type: 'state',
            common: {
                name: 'Stops the device if possible. Depends on prerequisites.',
                read: true,
                write: true,
                role: 'button',
                type: 'boolean',
            },
            native: { buttonType: 'button.stop' },
        },
        data,
    );
}

async function addPauseButton(adapter, path, data) {
    createOrExtendObject(
        adapter,
        `${path}.ACTIONS.Pause`,
        {
            type: 'state',
            common: {
                name: 'Pauses the device if possible. Depends on prerequisites.',
                read: true,
                write: true,
                role: 'button',
                type: 'boolean',
            },
            native: { buttonType: 'button.pause' },
        },
        data,
    );
}

async function addLightSwitch(adapter, path, currentState) {
    await createRWState(
        adapter,
        `${path}.ACTIONS.Light`,
        'Light switch of the device',
        currentState,
        'boolean',
        'switch',
        '',
    );
}

/**
 * createChannelIdent
 *
 * create the channel for Ident-information
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 */
async function createChannelIdent(adapter, path) {
    await createOrExtendObject(
        adapter,
        path,
        {
            type: 'channel',
            common: {
                name: 'Available ident information for this device',
                read: true,
                write: false,
                icon: 'icons/info.svg',
                type: 'object',
            },
            native: {},
        },
        null,
    );
}

/**
 * createChannelEcoFeedback
 *
 * create the channel for EcoFeedback-information
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 */
async function createChannelEcoFeedback(adapter, path) {
    await createOrExtendObject(
        adapter,
        `${path}.EcoFeedback`,
        {
            type: 'channel',
            common: {
                name: 'EcoFeedback information available for this device',
                read: true,
                write: false,
                icon: 'icons/eco.svg',
                type: 'object',
            },
            native: {},
        },
        null,
    );
}

/**
 * Function createString
 *
 * Adds a string data point to the device tree
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param description {string} description of the data point
 * @param value {string} value to set to the data point
 */
async function createString(adapter, path, description, value) {
    await createROState(adapter, path, description, value, 'string', 'text');
}

/**
 * Function createROState
 *
 * Adds a read only state of various type to the device tree
 *
 * @param adapter link to the adapter instance
 * @param path  path where the data point is going to be created
 * @param description description of the data point
 * @param type valid type of this state
 * @param role valid role of this state
 * @param value value to set to the data point
 */
async function createROState(adapter, path, description, value, type, role) {
    if (typeof value === 'undefined') {
        return;
    }
    createOrExtendObject(
        adapter,
        path,
        {
            type: 'state',
            common: { name: description, read: true, write: false, role: role, type: type },
            native: {},
        },
        value,
    );
}

/**
 * Function createRWState
 *
 * Adds a read/write state of various type to the device tree
 *
 * @param adapter link to the adapter instance
 * @param path  path where the data point is going to be created
 * @param description description of the data point
 * @param type valid type of this state
 * @param role valid role of this state
 * @param states valid states object for this switch
 * @param value value to set to the data point
 */
async function createRWState(adapter, path, description, value, type, role, states) {
    if (typeof value === 'undefined') {
        return;
    }
    const commonObj = {};
    commonObj.name = description;
    commonObj.read = true;
    commonObj.write = true;
    commonObj.role = role;
    commonObj.type = type;
    if (states) {
        commonObj.states = states;
    }
    createOrExtendObject(
        adapter,
        path,
        {
            type: 'state',
            common: commonObj,
            native: {},
        },
        value,
    );
}

/**
 * Function createNumber
 *
 * Adds a number data point to the device tree
 * Unit "Celsius" will be converted to "°C" and "Fahrenheit" to "°F"
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param description {string} description of the data point
 * @param value {number} value to set to the data point
 * @param unit {string} unit to set to the data point
 * @param role {string} role to set to the data point (default: text)
 */
async function createNumber(adapter, path, description, value, unit, role) {
    //adapter.log.debug('[createNumber]: Path['+ path +'] Value[' + value + '] Unit[' + unit + ']');
    // get back to calling function if there is no valid value given.
    if (typeof value === 'undefined' || value === -32768 || value == null) {
        adapter.log.debug(`[createNumber]: invalid value (${value}) detected. Skipping...`);
        return;
    }
    role = role || 'value';
    switch (unit) {
        case 'Celsius':
            unit = '°C';
            break;
        case 'Fahrenheit':
            unit = '°F';
            break;
    }
    createOrExtendObject(
        adapter,
        path,
        {
            type: 'state',
            common: { name: description, read: true, write: false, role: role, type: 'number', unit: unit },
            native: {},
        },
        value,
    );
}

/**
 * Function createTime
 *
 * Adds a time data point to the device tree by a given array containing [hours, minutes]
 *
 * @param adapter {object} link to the adapter instance
 * @param path {string} path where the data point is going to be created
 * @param description {string} description of the data point
 * @param value {object} array value to set to the data point
 * @param role {string} role to set to the data point (default: text)
 */
async function createTime(adapter, path, description, value, role) {
    await createOrExtendObject(
        adapter,
        path,
        {
            type: 'state',
            common: {
                name: description,
                read: true,
                write: path.split('.').pop() === 'startTime',
                role: role,
                type: 'string',
            },
            native: {},
        },
        `${value[0]}:${value[1] < 10 ? '0' : ''}${value[1]}`,
    );
}

/**
 * Function Create or extend object
 *
 * Updates an existing object (id) or creates it if not existing.
 * In case id and name are equal, it will only set it's new state
 *
 * @param adapter link to the adapters instance
 * @param id path/id of datapoint to create
 * @param objData details to the datapoint to be created (Device, channel, state, ...)
 * @param value value of the datapoint
 */
function createOrExtendObject(adapter, id, objData, value) {
    adapter.getObject(id, function (err, oldObj) {
        if (!err && oldObj) {
            // todo must be: objData.common.name === oldObj.common.name
            if (objData.common.name === oldObj.common.name) {
                adapter.setState(id, value, true);
            } else {
                adapter.extendObject(id, objData, () => {
                    adapter.setState(id, value, true);
                });
            }
        } else {
            adapter.setObjectNotExists(id, objData, () => {
                adapter.setState(id, value, true);
            });
        }
    });
}
