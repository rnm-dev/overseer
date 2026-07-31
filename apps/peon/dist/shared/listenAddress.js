export function parseListenAddress(value) {
    const raw = value.trim();
    if (!raw)
        throw new Error("listenAddress must not be empty");
    let url;
    try {
        url = new URL(`http://${raw}`);
    }
    catch {
        throw new Error("listenAddress must be host:port (for IPv6 use [address]:port)");
    }
    if (!url.hostname
        || !url.port
        || url.username
        || url.password
        || url.pathname !== "/"
        || url.search
        || url.hash) {
        throw new Error("listenAddress must be host:port (for IPv6 use [address]:port)");
    }
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("listenAddress port must be between 1 and 65535");
    }
    const host = url.hostname.startsWith("[") && url.hostname.endsWith("]")
        ? url.hostname.slice(1, -1)
        : url.hostname;
    const renderedHost = host.includes(":") ? `[${host}]` : host;
    return { host, port, canonical: `${renderedHost}:${port}` };
}
