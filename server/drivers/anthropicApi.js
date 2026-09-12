// ── Anthropic API driver ─────────────────────────────────────────────────────
//  Talks to the Messages API directly. Tools are the same definitions the MCP
//  server exposes, but executed in-process against GameApi. The whole game is
//  one conversation, kept bounded by a sliding window plus a model-written
//  summary of whatever fell off the back.
//
//  Events: 'text' {text}, 'tool_use' {name,input}, 'usage' {...},
//          'turn' {costUsd,durationMs,error}, 'model' {model}, 'status' {text}
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { TOOL_DEFS, toJsonSchema, formatResult } from '../tools.js';
import { priceOf } from '../ledger.js';

const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 8192;
const MAX_CALLS_PER_TURN = 40;      // model calls, i.e. tool rounds, before we force a turn end
const KEEP_TURNS = 6;               // turns kept verbatim when the window compacts
const FRESH_TURNS = 2;              // turns whose tool results stay untruncated
const RETRIES = 4;

export class AnthropicApiDriver extends EventEmitter {

    constructor ( api, { systemPrompt, model, maxContextTokens, thinking = true, effort, logFile, client } = {} ) {
        super();
        this.api = api;
        this.systemPrompt = systemPrompt;
        this.model = model || DEFAULT_MODEL;
        this.maxContextTokens = maxContextTokens || 80_000;
        this.thinking = thinking; this.effort = effort;
        this.logFile = logFile;
        this.tools = TOOL_DEFS.map( toJsonSchema );
        this.turns = [];            // [{ messages: [...] }] — one per send()
        this.lastInput = 0;         // prompt size of the most recent call, all buckets
        this.busy = false; this.stopped = false;
        this.client = client || null;       // injectable for tests
    }

    get name () { return `api:${ this.model }`; }

    start () {
        if ( !this.client ) {
            if ( !process.env.ANTHROPIC_API_KEY ) throw new Error( 'ANTHROPIC_API_KEY is not set' );
            this.client = new Anthropic();
        }
        this.stopped = false;
        this.emit( 'model', { model: this.model } );
        this.emit( 'status', { text: `started ${ this.name }` } );
    }

    stop () { this.stopped = true; this._abort?.abort(); }

    // One user turn: prompt in, tool rounds until the model stops talking.
    async send ( text ) {
        if ( !this.client ) throw new Error( 'driver not started' );
        if ( this.busy ) throw new Error( 'driver busy' );
        this.busy = true;
        const t0 = Date.now();
        let error = null, cost = 0;
        try {
            await this._compactIfNeeded();
            const turn = { messages: [ { role: 'user', content: text } ] };
            this.turns.push( turn );
            for ( let calls = 0; calls < MAX_CALLS_PER_TURN && !this.stopped; calls++ ) {
                const msg = await this._call( this._messages() );
                cost += this._account( msg );
                turn.messages.push( { role: 'assistant', content: msg.content } );
                const uses = msg.content.filter( ( b ) => b.type === 'tool_use' );
                for ( const b of msg.content ) {
                    if ( b.type === 'text' && b.text.trim() ) this.emit( 'text', { text: b.text } );
                    if ( b.type === 'tool_use' ) this.emit( 'tool_use', { name: b.name, input: b.input } );
                }
                if ( !uses.length ) break;
                const results = [];
                for ( const u of uses ) {
                    const content = await this._run( u );
                    results.push( { type: 'tool_result', tool_use_id: u.id, content, ...( content.startsWith( 'ERROR:' ) ? { is_error: true } : {} ) } );
                }
                turn.messages.push( { role: 'user', content: results } );
                if ( msg.stop_reason === 'max_tokens' ) break;
            }
            this._ageOut();
        } catch ( err ) {
            error = err.message || String( err );
            this._unwindPending();
        } finally {
            this.busy = false;
        }
        this.emit( 'turn', { costUsd: cost, cumulative: false, durationMs: Date.now() - t0, error } );
        if ( error ) throw new Error( error );
    }

    // ── model call ──────────────────────────────────────────────────────────

    async _call ( messages, extra = {} ) {
        const params = {
            model: this.model, max_tokens: MAX_TOKENS,
            system: this.systemPrompt, tools: this.tools, messages,
            cache_control: { type: 'ephemeral' },        // cache the whole prefix, moving with the conversation
            ...extra,
        };
        if ( this.thinking ) params.thinking = { type: 'adaptive' };
        if ( this.effort ) params.output_config = { effort: this.effort };
        let wait = 2000;
        for ( let attempt = 0; ; attempt++ ) {
            this._abort = new AbortController();
            try {
                const stream = this.client.messages.stream( params, { signal: this._abort.signal } );
                const msg = await stream.finalMessage();
                if ( this.logFile ) fs.appendFile( this.logFile, JSON.stringify( { at: Date.now(), msg } ) + '\n', () => {} );
                return msg;
            } catch ( err ) {
                const retryable = err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError;
                if ( this.stopped || !retryable || attempt >= RETRIES ) throw err;
                this.emit( 'status', { text: `${ err.constructor.name }, retrying in ${ wait / 1000 }s` } );
                await new Promise( ( r ) => setTimeout( r, wait ) );
                wait = Math.min( wait * 2, 30_000 );
            }
        }
    }

    _account ( msg ) {
        const u = msg.usage || {};
        const step = { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 };
        this.lastInput = step.input + step.cacheRead + step.cacheWrite;
        this.emit( 'usage', step );
        return priceOf( this.model, step );
    }

    async _run ( use ) {
        const fn = this.api[ use.name ];
        if ( typeof fn !== 'function' || !TOOL_DEFS.some( ( d ) => d.name === use.name ) ) return `ERROR: unknown tool ${ use.name }`;
        try { return formatResult( await fn.call( this.api, use.input || {} ) ); }
        catch ( err ) { return `ERROR: ${ err.message }`; }
    }

    // ── history ─────────────────────────────────────────────────────────────

    _messages () { return this.turns.flatMap( ( t ) => t.messages ); }

    // A failed call leaves the last turn ending on a user message. Drop back to
    // the last assistant/tool_result pair so the next send starts clean.
    _unwindPending () {
        const turn = this.turns.at( -1 );
        if ( !turn ) return;
        const last = turn.messages.at( -1 );
        if ( last?.role !== 'user' ) return;
        turn.messages.pop();
        // If that was a tool_result batch, its assistant tool_use must go too.
        if ( Array.isArray( last.content ) && turn.messages.at( -1 )?.role === 'assistant' ) turn.messages.pop();
        if ( !turn.messages.length ) this.turns.pop();
    }

    // Old tool results shrink to a line; the model can always re-query.
    _ageOut () {
        for ( const turn of this.turns.slice( 0, -FRESH_TURNS ) ) {
            if ( turn.aged ) continue;
            turn.aged = true;
            for ( const m of turn.messages ) {
                if ( m.role !== 'user' || !Array.isArray( m.content ) ) continue;
                for ( const r of m.content ) {
                    if ( r.type !== 'tool_result' || typeof r.content !== 'string' ) continue;
                    if ( r.content.length <= 240 ) continue;
                    r.content = r.content.replace( /\s+/g, ' ' ).slice( 0, 160 ) + ' …(older result truncated)';
                }
            }
        }
    }

    // When the prompt outgrows the budget, everything but the latest turns is
    // replaced by a note the model writes about its own city.
    async _compactIfNeeded () {
        if ( this.lastInput < this.maxContextTokens || this.turns.length <= KEEP_TURNS ) return;
        const old = this.turns.slice( 0, -KEEP_TURNS );
        const keep = this.turns.slice( -KEEP_TURNS );
        this.emit( 'status', { text: `compacting ${ old.length } turns (${ this.lastInput } tokens in context)` } );
        const ask = { role: 'user', content: 'Pause the game for a moment. Write a "state of the city" note for yourself, under 300 words: the city name and story so far, the layout (where the districts, power, and main roads are, with coordinates), current plans and problems, promises made to viewers and their names. Plain text, no tool calls.' };
        const msg = await this._call( [ ...old.flatMap( ( t ) => t.messages ), ask ], { tool_choice: { type: 'none' } } );
        this._account( msg );
        const note = msg.content.filter( ( b ) => b.type === 'text' ).map( ( b ) => b.text ).join( '\n' ).trim();
        if ( !note ) return;
        const summary = { aged: true, messages: [
            { role: 'user', content: `[Earlier play, summarised by you]\n${ note }` },
            { role: 'assistant', content: 'Noted. Continuing from there.' },
        ] };
        this.turns = [ summary, ...keep ];
        this.lastInput = 0;
        this.emit( 'status', { text: `context compacted to ${ this.turns.length } turns` } );
    }

}
