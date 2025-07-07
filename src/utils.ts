import { BigNumber } from "ethers";
import { TokenDetails } from "./state";
import { RainSolverSigner } from "./signer";

/**
 * Waits for provided miliseconds
 * @param ms - Miliseconds to wait
 */
export async function sleep(ms: number, msg = "") {
    let _timeoutReference: string | number | NodeJS.Timeout | undefined;
    return new Promise(
        (resolve) => (_timeoutReference = setTimeout(() => resolve(msg), ms)),
    ).finally(() => clearTimeout(_timeoutReference));
}

/**
 * Method to shorten data fields of items that are logged and optionally hide sensitive data
 * @param scrub - Option to scrub sensitive data
 * @param data - The optinnal data to hide
 */
export function appGlobalLogger(scrub: boolean, ...data: any[]) {
    // const largeDataPattern = /0x[a-fA-F0-9]{128,}/g;
    const consoleMethods = ["log", "warn", "error", "info", "debug"];

    // Stringifies an object
    const objStringify = (obj: any) => {
        const keys = Object.getOwnPropertyNames(obj);
        for (let i = 0; i < keys.length; i++) {
            if (
                typeof obj[keys[i]] === "bigint" ||
                typeof obj[keys[i]] === "number" ||
                typeof obj[keys[i]] === "symbol"
            )
                obj[keys[i]] = obj[keys[i]].toString();
            else if (typeof obj[keys[i]] === "object" && obj[keys[i]] !== null) {
                obj[keys[i]] = objStringify(obj[keys[i]]);
            }
        }
        return obj;
    };

    // Replaces a search value with replace value in an object's properties string content
    const objStrReplacer = (logObj: any, searchee: any, replacer: any) => {
        const objKeys = Object.getOwnPropertyNames(logObj);
        for (let i = 0; i < objKeys.length; i++) {
            if (typeof logObj[objKeys[i]] === "string" && logObj[objKeys[i]]) {
                if (typeof searchee === "string") {
                    // while (logObj[objKeys[i]].includes(searchee)) {
                    logObj[objKeys[i]] = logObj[objKeys[i]].replaceAll(searchee, replacer);
                    // }
                } else logObj[objKeys[i]] = logObj[objKeys[i]].replace(searchee, replacer);
            } else if (typeof logObj[objKeys[i]] === "object" && logObj[objKeys[i]] !== null) {
                logObj[objKeys[i]] = objStrReplacer(logObj[objKeys[i]], searchee, replacer);
            }
        }
        return logObj;
    };

    // filtering unscrubable data
    const _data = data
        .filter((v) => v !== undefined && v !== null)
        .map((v) => {
            try {
                let str;
                if (typeof v !== "string") str = v.toString();
                else str = v;
                if (str) return str;
                else return undefined;
            } catch {
                return undefined;
            }
        })
        .filter((v) => v !== undefined);

    // intercepting the console with custom function to scrub and shorten loggings
    consoleMethods.forEach((methodName) => {
        // eslint-disable-next-line no-console
        const orgConsole = (console as any)[methodName];
        // eslint-disable-next-line no-console
        (console as any)[methodName] = function (...params: any[]) {
            const modifiedParams: any[] = [];
            // const shortenedLogs = [];
            for (let i = 0; i < params.length; i++) {
                let logItem = params[i];
                if (
                    typeof logItem === "number" ||
                    typeof logItem === "bigint" ||
                    typeof logItem === "symbol"
                )
                    logItem = logItem.toString();

                if (typeof logItem === "string") {
                    if (scrub)
                        for (let j = 0; j < _data.length; j++) {
                            // while (logItem.includes(_data[i]))
                            logItem = logItem.replaceAll(_data[j], "**********");
                        }
                    // logItem = logItem.replace(
                    //     largeDataPattern,
                    //     largeData => {
                    //         if (!shortenedLogs.includes(largeData)) {
                    //             shortenedLogs.push(largeData);
                    //             return largeData;
                    //         }
                    //         else return largeData.slice(0, 67) + "...";
                    //     }
                    // );
                } else if (typeof logItem === "object" && logItem !== null) {
                    logItem = objStringify(logItem);
                    if (scrub)
                        for (let j = 0; j < _data.length; j++) {
                            logItem = objStrReplacer(logItem, _data[j], "**********");
                        }
                    // logItem = objStrReplacer(
                    //     logItem,
                    //     largeDataPattern,
                    //     largeData => {
                    //         if (!shortenedLogs.includes(largeData)) {
                    //             shortenedLogs.push(largeData);
                    //             return largeData;
                    //         }
                    //         else return largeData.slice(0, 67) + "...";
                    //     }
                    // );
                }
                modifiedParams.push(logItem);
            }
            orgConsole.apply(console, modifiedParams);
        };
    });
}

/**
 * Method to put a timeout on a promise, throws the exception if promise is not settled within the time
 * @param promise - The Promise to put timeout on
 * @param time - The time in milliseconds
 * @param exception - The exception value to reject with if the promise is not settled within time
 * @returns A new promise that gets settled with initial promise settlement or rejected with exception value
 * if the time runs out before the main promise settlement
 */
export async function promiseTimeout(
    promise: Promise<any>,
    time: number,
    exception: Error | string | number | bigint | symbol | boolean,
) {
    let timer: string | number | NodeJS.Timeout | undefined;
    return Promise.race([
        promise,
        new Promise((_res, _rej) => (timer = setTimeout(_rej, time, exception))),
    ]).finally(() => clearTimeout(timer));
}

/**
 * Shuffles an array
 * @param array - The array
 */
export function shuffleArray(array: any[]) {
    let currentIndex = array.length;
    let randomIndex = 0;

    // While there remain elements to shuffle.
    while (currentIndex > 0) {
        // Pick a remaining element.
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;

        // And swap it with the current element.
        [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
    }

    return array;
}

/**
 * Clones the given object
 * @param obj - Object to clone
 * @returns A new copy of the object
 */
export function clone<T>(obj: any): T {
    if (obj instanceof BigNumber) {
        return BigNumber.from(obj.toString()) as T;
    } else if (Array.isArray(obj)) {
        return obj.map((item) => clone(item)) as T;
    } else if (typeof obj === "object") {
        const result: any = {};
        for (const key in obj) {
            const value = obj[key];
            result[key] = clone(value);
        }
        return result;
    } else {
        return obj;
    }
}

/**
 * Json serializer function for handling bigint type
 */
export function withBigintSerializer(_k: string, v: any) {
    if (typeof v == "bigint") {
        return v.toString();
    } else if (v instanceof Set) {
        return Array.from(v);
    } else {
        return v;
    }
}

/**
 * Helper function to log memory usage
 */
export function memory(msg: string) {
    // eslint-disable-next-line no-console
    console.log(msg);
    for (const [key, value] of Object.entries(process.memoryUsage())) {
        // eslint-disable-next-line no-console
        console.log(`Memory usage by ${key}, ${value / 1_000_000}MB `);
    }
    // eslint-disable-next-line no-console
    console.log("\n---\n");
}

/**
 * Adds the given k/v pairs to the spanAttributes by prepending the key with given header
 */
export function extendSpanAttributes(
    spanAttributes: Record<string, any>,
    newAttributes: Record<string, any>,
    header: string,
    excludeHeaderForKeys: string[] = [],
) {
    for (const attrKey in newAttributes) {
        if (!excludeHeaderForKeys.includes(attrKey)) {
            Object.assign(spanAttributes, { [header + "." + attrKey]: newAttributes[attrKey] });
        } else {
            Object.assign(spanAttributes, { [attrKey]: newAttributes[attrKey] });
        }
    }
}

/**
 * Adds the given token details to the given list
 */
export function addWatchedToken(
    token: TokenDetails,
    watchedTokens: TokenDetails[],
    account?: RainSolverSigner,
) {
    if (!watchedTokens.find((v) => v.address.toLowerCase() === token.address.toLowerCase())) {
        watchedTokens.push(token);
    }
    if (account) {
        if (!account.BOUNTY.find((v) => v.address.toLowerCase() === token.address.toLowerCase())) {
            account.BOUNTY.push(token);
        }
    }
}
