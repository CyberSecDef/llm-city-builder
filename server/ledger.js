// ── Ledger ───────────────────────────────────────────────────────────────────
//  Token and cost accounting, shared by every driver. Drivers report per-call
//  usage; the ledger keeps running totals and a per-turn history. Cost is
//  estimated from a price table as tokens arrive and replaced by the driver's
//  authoritative figure (Claude Code's total_cost_usd) whenever one shows up.
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'node:events';

// USD per million tokens: [input, output, cacheWrite, cacheRead]. Matched by substring of the model id.
const PRICES = [
    [ 'haiku',  [ 1, 5, 1.25, 0.10 ] ],
    [ 'sonnet', [ 3, 15, 3.75, 0.30 ] ],
    [ 'opus',   [ 5, 25, 6.25, 0.50 ] ],
    [ 'fable',  [ 5, 25, 6.25, 0.50 ] ],   // assumed; corrected by the driver's reported cost
];

export class Ledger extends EventEmitter {

    constructor () {
        super();
        this.model  = null;
        this.totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, estimated: true, steps: 0, turns: 0 };
        this.turns  = [];      // { at, input, output, cacheRead, cacheWrite, costUsd, durationMs }
        this._turn  = null;
        this._reported = 0;    // authoritative cost to date, if the driver gives one
        this._estimatedSince = 0; // estimated cost accrued since the last authoritative figure
    }

    setModel ( model ) { this.model = model; }

    serialize () { return { model: this.model, totals: this.totals, turns: this.turns.slice( -100 ), reported: this._reported }; }
    restore ( s ) {
        if ( !s ) return;
        this.model = s.model || this.model; this.totals = { ...this.totals, ...s.totals };
        this.turns = s.turns || []; this._reported = s.reported || 0;
        this.emit( 'update', this.snapshot() );
    }

    beginTurn () {
        this._turn = { at: Date.now(), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, durationMs: 0 };
    }

    // One model call's usage.
    addStep ( { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } ) {
        const cost = this._price( { input, output, cacheRead, cacheWrite } );
        for ( const t of [ this.totals, this._turn ].filter( Boolean ) ) {
            t.input += input; t.output += output; t.cacheRead += cacheRead; t.cacheWrite += cacheWrite; t.costUsd += cost;
        }
        this._estimatedSince += cost;
        this.totals.steps++;
        this.emit( 'update', this.snapshot() );
    }

    // Turn finished. `cumulative` = costUsd is session-to-date, not a delta.
    endTurn ( { costUsd = 0, cumulative = false, durationMs = 0 } = {} ) {
        if ( !this._turn ) this.beginTurn();
        if ( costUsd > 0 ) {
            const reported = cumulative ? costUsd : this._reported + costUsd;
            const delta = reported - this._reported;
            this._turn.costUsd = delta;
            this.totals.costUsd = reported;          // replace estimate with the real thing
            this._reported = reported; this._estimatedSince = 0;
            this.totals.estimated = false;
        }
        this._turn.durationMs = durationMs;
        this.totals.turns++;
        this.turns.push( this._turn ); if ( this.turns.length > 500 ) this.turns.shift();
        this._turn = null;
        this.emit( 'update', this.snapshot() );
    }

    // priced=false: no price row for this model and the driver reports no cost,
    // so costUsd is meaningless (Codex on a ChatGPT login, for instance).
    snapshot () { return { ...this.totals, costUsd: round( this.totals.costUsd ), model: this.model, priced: !this.totals.estimated || hasPrice( this.model ) }; }

    _price ( u ) { return priceOf( this.model, u ); }

}

export const hasPrice = ( model ) => PRICES.some( ( [ k ] ) => ( model || '' ).includes( k ) );

// USD for one call's usage, 0 if the model is unknown to the table.
export function priceOf ( model, { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } ) {
    const row = PRICES.find( ( [ k ] ) => ( model || '' ).includes( k ) );
    if ( !row ) return 0;
    const [ i, o, w, r ] = row[ 1 ];
    return ( input * i + output * o + cacheWrite * w + cacheRead * r ) / 1e6;
}

const round = ( v ) => Math.round( v * 1e4 ) / 1e4;
