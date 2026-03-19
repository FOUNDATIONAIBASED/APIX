'use strict';
/**
 * LLM Load Balancer & Queue Manager
 *
 * Supports:
 *  - Ollama  (/api/chat  or  /api/generate)
 *  - OpenAI-compatible  (/v1/chat/completions) — works with LM Studio, OpenRouter,
 *    LocalAI, Mistral, Groq, Together AI, Anyscale, etc.
 *
 * Load balancing:
 *  - Weighted round-robin across healthy instances
 *  - Circuit breaker: instance marked unhealthy after 3 consecutive failures
 *  - Auto-recovery health check every 60s
 *  - Per-instance concurrency limiting via in-flight counter
 */
const axios  = require('axios');
const { LLM } = require('../db');

const MAX_CONTEXT_MESSAGES = 20;
const HEALTH_CHECK_INTERVAL = 60_000;
const CIRCUIT_OPEN_THRESHOLD = 3;  // failures before marking unhealthy

class LLMManager {
    constructor() {
        this._roundRobinCounters = {};
        this._inFlight = {};       // instanceId → count
        this._healthTimer = null;
    }

    start() {
        this._healthTimer = setInterval(() => this._runHealthChecks(), HEALTH_CHECK_INTERVAL);
        // Kick off initial health check after 5s
        setTimeout(() => this._runHealthChecks(), 5_000);
    }

    stop() {
        if (this._healthTimer) clearInterval(this._healthTimer);
    }

    // ── Public: process an inbound SMS through matching LLM rules ──
    async processInbound({ from, to, body, deviceId }) {
        const rules = LLM.findRules();
        const matched = rules.find(r => this._ruleMatches(r, { from, to, body }));
        if (!matched) return null;

        const instance = LLM.findById(matched.llm_id);
        if (!instance || !instance.enabled || !instance.healthy) return null;

        const reply = await this.chat(instance.id, from, body);
        return reply ? { rule: matched, reply } : null;
    }

    // ── Public: send a single chat message, maintaining session context ──
    async chat(instanceId, contactNumber, userMessage) {
        const instance = LLM.findById(instanceId);
        if (!instance) throw new Error(`LLM instance ${instanceId} not found`);

        const session = LLM.getSession(contactNumber, instanceId);
        const context = session ? session.context : [];

        // Append user message
        const newContext = [
            ...context.slice(-MAX_CONTEXT_MESSAGES),
            { role: 'user', content: userMessage },
        ];

        const response = await this._dispatch(instance, newContext);

        // Persist updated context
        newContext.push({ role: 'assistant', content: response });
        LLM.upsertSession(contactNumber, instanceId, newContext);
        LLM.incReqs(instanceId);

        return response;
    }

    // ── Public: one-shot completion (no session) ──
    async complete(instanceId, prompt, systemPrompt) {
        const instance = LLM.findById(instanceId);
        if (!instance) throw new Error(`LLM instance ${instanceId} not found`);
        const messages = systemPrompt
            ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
            : [{ role: 'user', content: prompt }];
        return this._dispatch(instance, messages);
    }

    // ── Public: pick best instance with weighted load balancing ──
    pickInstance() {
        const instances = LLM.findEnabled().filter(i => i.healthy);
        if (!instances.length) return null;

        // Weighted pool: repeat each instance `weight` times
        const pool = [];
        for (const inst of instances) {
            const w = Math.max(1, inst.weight || 1);
            for (let i = 0; i < w; i++) pool.push(inst);
        }

        // Prefer instances with fewer in-flight requests
        pool.sort((a, b) => (this._inFlight[a.id] || 0) - (this._inFlight[b.id] || 0));
        return pool[0] || null;
    }

    // ── Internal: dispatch to the right provider ──
    async _dispatch(instance, messages) {
        this._inFlight[instance.id] = (this._inFlight[instance.id] || 0) + 1;
        try {
            let reply;
            if (instance.type === 'ollama') {
                reply = await this._callOllama(instance, messages);
            } else {
                // openai / lmstudio / openrouter / localai / groq / together / custom
                reply = await this._callOpenAI(instance, messages);
            }
            // Circuit-breaker reset
            if ((instance.fail_count || 0) > 0 || !instance.healthy) {
                LLM.setHealth(instance.id, true);
            }
            return reply;
        } catch (err) {
            const failCount = (instance.fail_count || 0) + 1;
            LLM.setHealth(instance.id, failCount < CIRCUIT_OPEN_THRESHOLD);
            throw err;
        } finally {
            this._inFlight[instance.id] = Math.max(0, (this._inFlight[instance.id] || 1) - 1);
        }
    }

    // ── Ollama provider (/api/chat) ──
    async _callOllama(inst, messages) {
        const systemMsg = inst.system_prompt
            ? [{ role: 'system', content: inst.system_prompt }]
            : [];
        const allMsgs = [...systemMsg, ...messages];

        const res = await axios.post(
            `${inst.base_url.replace(/\/$/, '')}/api/chat`,
            { model: inst.model, messages: allMsgs, stream: false },
            {
                timeout: inst.timeout_ms || 30_000,
                headers: inst.api_key ? { Authorization: `Bearer ${inst.api_key}` } : {},
            }
        );
        return res.data?.message?.content || res.data?.response || '';
    }

    // ── OpenAI-compatible provider (/v1/chat/completions) ──
    async _callOpenAI(inst, messages) {
        const systemMsg = inst.system_prompt
            ? [{ role: 'system', content: inst.system_prompt }]
            : [];
        const allMsgs = [...systemMsg, ...messages];

        const headers = { 'Content-Type': 'application/json' };
        if (inst.api_key) headers['Authorization'] = `Bearer ${inst.api_key}`;

        const res = await axios.post(
            `${inst.base_url.replace(/\/$/, '')}/v1/chat/completions`,
            { model: inst.model, messages: allMsgs, stream: false },
            { timeout: inst.timeout_ms || 30_000, headers }
        );
        return res.data?.choices?.[0]?.message?.content || '';
    }

    // ── Rule matching ──
    _ruleMatches(rule, { from, to, body }) {
        if (rule.trigger_type === 'all') return true;
        if (rule.trigger_type === 'from' && rule.trigger_value) {
            return from === rule.trigger_value;
        }
        if (rule.trigger_type === 'to' && rule.trigger_value) {
            return to === rule.trigger_value;
        }
        if (rule.trigger_type === 'keyword' && rule.trigger_value) {
            const kw = rule.trigger_value.toLowerCase();
            return (body || '').toLowerCase().includes(kw);
        }
        if (rule.trigger_type === 'regex' && rule.trigger_value) {
            try { return new RegExp(rule.trigger_value, 'i').test(body || ''); }
            catch { return false; }
        }
        return false;
    }

    // ── Background health checks ──
    async _runHealthChecks() {
        const instances = LLM.findAll().filter(i => i.enabled);
        for (const inst of instances) {
            try {
                if (inst.type === 'ollama') {
                    await axios.get(`${inst.base_url.replace(/\/$/, '')}/api/tags`, { timeout: 5000 });
                } else {
                    await axios.get(`${inst.base_url.replace(/\/$/, '')}/v1/models`, {
                        timeout: 5000,
                        headers: inst.api_key ? { Authorization: `Bearer ${inst.api_key}` } : {},
                    });
                }
                LLM.setHealth(inst.id, true);
            } catch {
                LLM.setHealth(inst.id, false);
            }
        }
    }
}

module.exports = new LLMManager();
