export function fail(res, status, code, error) {
    res.status(status).json({ error, code });
}
