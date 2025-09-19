import { RpcMetrics, RpcState } from "./rpc";
import { normalizeUrl, shouldThrow } from "./helpers";

/**
 * A fetch request hook for the viem http client that is used to keeps track of rpc metrics
 * @param request - The fetch request object
 */
export function onFetchRequest(this: RpcState, request: Request) {
    const url = normalizeUrl(request.url);
    let record = this.metrics[url];
    if (!record) {
        record = this.metrics[url] = new RpcMetrics();
    }
    record.recordRequest();
}

/**
 * A fetch response hook for the viem http client that is used to keeps track of rpc metrics
 * @param response - The fetch response object
 */
export async function onFetchResponse(this: RpcState, response: Response) {
    const _response = response.clone();
    const url = normalizeUrl(_response.url);
    let record = this.metrics[url];
    if (!record) {
        // this cannot really happen, but just to be sure,
        // initialize this rpc record if its not already
        record = this.metrics[url] = new RpcMetrics();
        record.recordRequest();
    }

    if (!_response.ok) {
        record.recordFailure();
        return;
    }

    const handleResponse = (res: any) => {
        if ("result" in res) {
            record.recordSuccess();
            return;
        } else if ("error" in res) {
            if (shouldThrow(res.error)) {
                record.recordSuccess();
                return;
            }
        }
        record.recordFailure();
    };
    if (_response.headers.get("Content-Type")?.startsWith("application/json")) {
        await _response
            .json()
            .then((res: any) => {
                handleResponse(res);
            })
            .catch(() => {
                record.recordFailure();
            });
    } else {
        await _response
            .text()
            .then((text) => {
                try {
                    const res = JSON.parse(text || "{}");
                    handleResponse(res);
                } catch (err) {
                    record.recordFailure();
                }
            })
            .catch(() => {
                record.recordFailure();
            });
    }
}
