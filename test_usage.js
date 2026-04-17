const text = 'LLM_USAGE {"scope":"announcement_fetcher","model":"kimi-k2-turbo-preview","prompt_tokens":16476,"completion_tokens":245,"total_tokens":16721,"calls":8}';
const out = { prompt: 0, completion: 0, total: 0, calls: 0 };
const lines = String(text || '').split(/\r?\n/);
for (const line of lines) {
    const m = /^\s*LLM_USAGE\s+(.+)\s*$/.exec(line);
    if (!m) { console.log('NO MATCH:', line); continue; }
    const j = JSON.parse(m[1]);
    const pt = j.prompt_tokens != null ? Number(j.prompt_tokens) : NaN;
    const ct = j.completion_tokens != null ? Number(j.completion_tokens) : NaN;
    const tt = j.total_tokens != null ? Number(j.total_tokens) : NaN;
    console.log('parsed:', { pt, ct, tt, calls: j.calls });
    out.prompt += pt; out.completion += ct; out.total += (Number.isFinite(tt) && tt >= 0 ? tt : pt + ct); out.calls += j.calls;
}
console.log('totalUsage:', out);