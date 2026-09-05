// App-server counters are cumulative per thread; `last` is one model request,
// not a whole user turn. Keep this provider-specific arithmetic out of clients.
const fields = ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
function counts(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const out = {};
    for (const field of fields) {
        const value = raw[field];
        if (value !== undefined && value !== null) {
            if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
                return null;
            out[field] = value;
        }
    }
    if (out.inputTokens === undefined || out.outputTokens === undefined
        || (out.cachedInputTokens ?? 0) + (out.cacheWriteInputTokens ?? 0) > out.inputTokens
        || (out.reasoningOutputTokens ?? 0) > out.outputTokens)
        return null;
    return out;
}
export class CodexUsageAccumulator {
    previous = null;
    fallbackSeen = false;
    accumulated = {};
    models = new Map();
    uncertain = false;
    markPartial() { this.uncertain = true; }
    observe(raw, model) {
        const total = counts(raw.total);
        const last = counts(raw.last);
        if (!total) {
            // Without a cumulative counter duplicate notifications cannot be
            // distinguished from identical requests. Retain a lower bound only.
            this.uncertain = true;
            if (this.previous || this.fallbackSeen || !last)
                return false;
            this.fallbackSeen = true;
            this.add(last, model);
            return true;
        }
        if (this.previous && fields.every((key) => total[key] === this.previous[key]))
            return false;
        let delta;
        if (!this.previous) {
            if (this.fallbackSeen) {
                // We cannot know whether this cumulative update repeats the fallback
                // request. Establish a baseline without charging inherited history.
                this.previous = total;
                this.uncertain = true;
                return false;
            }
            // First active-turn event may carry years of resumed/forked history.
            // Its `last` is the first observable request, never charge that history.
            if (!last) {
                this.previous = total;
                this.uncertain = true;
                return false;
            }
            delta = last;
        }
        else if (fields.some((key) => total[key] !== undefined && this.previous[key] !== undefined && total[key] < this.previous[key])) {
            // Reset/compaction: don't subtract into negatives or recharge history.
            this.uncertain = true;
            if (!last) {
                this.previous = total;
                return false;
            }
            delta = last;
        }
        else {
            delta = {};
            for (const key of fields) {
                if (total[key] !== undefined && this.previous[key] !== undefined)
                    delta[key] = total[key] - this.previous[key];
                else if (last?.[key] !== undefined) {
                    delta[key] = last[key];
                    this.uncertain = true;
                }
            }
        }
        this.previous = total;
        this.add(delta, model);
        return true;
    }
    add(delta, model) {
        const key = model || "unknown";
        const row = this.models.get(key) ?? {};
        for (const field of fields)
            if (delta[field] !== undefined) {
                this.accumulated[field] = (this.accumulated[field] ?? 0) + delta[field];
                row[field] = (row[field] ?? 0) + delta[field];
            }
        this.models.set(key, row);
    }
    report(complete = false) {
        const wire = (value) => ({
            input_tokens: value.inputTokens,
            output_tokens: value.outputTokens,
            cache_read_input_tokens: value.cachedInputTokens,
            ...(value.cacheWriteInputTokens === undefined ? {} : { cache_creation_input_tokens: value.cacheWriteInputTokens }),
            ...(value.reasoningOutputTokens === undefined ? {} : { reasoning_output_tokens: value.reasoningOutputTokens }),
        });
        return {
            usage: wire(this.accumulated),
            usage_by_model: Object.fromEntries([...this.models].map(([key, value]) => [key, wire(value)])),
            usage_quality: complete && !this.uncertain ? "reported" : "partial",
            usage_source: "codex-thread-counters-v1",
        };
    }
}
