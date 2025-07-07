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
 * Shuffles an array in place
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
